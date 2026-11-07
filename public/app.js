'use strict';

/**
 * iShare — browser transfer engine
 * -----------------------------------
 * Signaling only goes through the WebSocket server. Files and text then travel
 * over an ordered, reliable RTCDataChannel. Files are sliced into 64 KB chunks
 * and throttled using the channel's bufferedAmount, so a large send never
 * requires the file to be loaded into memory at once.
 */

(() => {
  const protocol = window.IShareProtocol;
  if (!protocol) throw new Error('protocol.js failed to load');

  const SESSION_ID_KEY = 'ishare:client-id';
  const SESSION_ROOM_KEY = 'ishare:room';

  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
  const BUFFER_LOW_WATER = 512 * 1024;
  const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024;
  const MAX_TEXT_LENGTH = 20_000;
  const MAX_MESSAGES = 250;
  const MAX_TRANSFER_ROWS = 100;
  // The browser E2E suite shortens this through a pre-load test hook so the
  // two-minute wait does not dominate the run. It has no effect in production.
  const ACCEPT_TIMEOUT_MS = (() => {
    const override = Number(window.__ISHARE_TEST_ACCEPT_TIMEOUT_MS);
    return Number.isFinite(override) && override > 0 ? override : 2 * 60 * 1000;
  })();
  const DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;
  const CONNECT_TIMEOUT_MS = 15_000;
  const MAX_CONNECT_ATTEMPTS = 2;
  const PROTOCOL_VERSION = 1;
  const ROOM_CODE_LENGTH = 6;

  const DEFAULT_ICE_SERVERS = [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  ];

  const state = {
    ws: null,
    signaling: 'connecting',
    reconnectTimer: null,
    reconnectAttempts: 0,
    manualClose: false,
    rejoinBlocked: false,
    selfId: loadClientId(),
    selfName: '',
    pendingAutoJoin: null,
    room: null,
    maxPeers: 8,
    peers: new Map(),
    selectedPeers: new Set(),
    transfers: new Map(),
    messages: [],
    config: {
      iceServers: DEFAULT_ICE_SERVERS,
      iceTransportPolicy: 'all',
      iceTtl: 0,
      iceExpiresAt: 0,
      turnMode: 'none',
      version: '1.0.0',
    },
    configPromise: null,
    pendingRoomAction: null,
    joinTimer: null,
    leaving: false,
  };

  const els = {
    signalStatus: byId('signal-status'),
    signalLabel: byId('signal-label'),
    themeToggle: byId('theme-toggle'),
    versionChip: byId('version-chip'),
    footerVersion: byId('footer-version'),
    viewLanding: byId('view-landing'),
    viewRoom: byId('view-room'),
    joinForm: byId('join-form'),
    deviceName: byId('device-name'),
    btnCreate: byId('btn-create'),
    roomInput: byId('room-input'),
    btnJoin: byId('btn-join'),
    inviteHint: byId('invite-hint'),
    landingError: byId('landing-error'),
    offlineBanner: byId('offline-banner'),
    offlineMessage: byId('offline-message'),
    roomCodeDisplay: byId('room-code-display'),
    netChip: byId('net-chip'),
    btnCopyRoom: byId('btn-copy-room'),
    btnShowQr: byId('btn-show-qr'),
    btnCopyLink: byId('btn-copy-link'),
    btnLeave: byId('btn-leave'),
    peerCount: byId('peer-count'),
    peerList: byId('peer-list'),
    meshLabel: byId('mesh-label'),
    dropZone: byId('drop-zone'),
    fileInput: byId('file-input'),
    targetSummary: byId('target-summary'),
    targetText: byId('target-text'),
    textInput: byId('text-input'),
    textCounter: byId('text-counter'),
    btnSendText: byId('btn-send-text'),
    messageEmpty: byId('message-empty'),
    messageList: byId('message-list'),
    btnClearMessages: byId('btn-clear-messages'),
    transferCount: byId('transfer-count'),
    btnClearTransfers: byId('btn-clear-transfers'),
    transferEmpty: byId('transfer-empty'),
    transferList: byId('transfer-list'),
    qrDialog: byId('qr-dialog'),
    qrImage: byId('qr-image'),
    qrLoading: byId('qr-loading'),
    qrLinkText: byId('qr-link-text'),
    qrDownload: byId('qr-download'),
    btnCopyLinkModal: byId('btn-copy-link-modal'),
    btnCloseQr: byId('btn-close-qr'),
    toastRegion: byId('toast-region'),
    peerTemplate: byId('peer-template'),
    transferTemplate: byId('transfer-template'),
    messageTemplate: byId('message-template'),
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    setDefaultName();
    initTheme();
    hydrateRoomFromUrl();
    updateTextComposer();

    state.configPromise = loadConfig();
    connectSignaling();

    if (!('RTCPeerConnection' in window) || !('RTCDataChannel' in window)) {
      toast('This browser does not support WebRTC data channels. Use an up-to-date Chrome, Edge, Firefox, or Safari.', 'error', 9000);
    }
  }

  function bindEvents() {
    els.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      joinRoom();
    });

    els.btnCreate.addEventListener('click', createRoom);
    els.roomInput.addEventListener('input', () => {
      const caret = els.roomInput.selectionStart || 0;
      els.roomInput.value = normalizeRoomCodeInput(els.roomInput.value);
      const next = Math.min(caret, els.roomInput.value.length);
      try {
        els.roomInput.setSelectionRange(next, next);
      } catch (error) {
        /* Some mobile browsers reject setSelectionRange while composing. */
      }
      hideLandingError();
    });

    els.btnCopyRoom.addEventListener('click', () => {
      if (state.room) copyText(state.room, 'Room code copied.');
    });
    els.btnCopyLink.addEventListener('click', () => {
      if (state.room) copyText(roomUrl(), 'Invite link copied.');
    });
    els.btnCopyLinkModal.addEventListener('click', () => {
      if (state.room) copyText(roomUrl(), 'Invite link copied.');
    });
    els.btnShowQr.addEventListener('click', openQrDialog);
    els.btnCloseQr.addEventListener('click', closeQrDialog);
    els.btnLeave.addEventListener('click', leaveRoom);

    els.qrDialog.addEventListener('click', (event) => {
      if (event.target === els.qrDialog) closeQrDialog();
    });
    els.qrDialog.addEventListener('close', () => {
      document.body.classList.remove('modal-open');
    });

    els.peerList.addEventListener('click', (event) => {
      const button = event.target.closest('.peer__button');
      if (!button) return;
      const item = button.closest('.peer');
      if (!item || item.classList.contains('peer--self')) return;
      const peerId = item.dataset.peerId;
      if (!peerId) return;
      togglePeerSelection(peerId);
    });

    els.dropZone.addEventListener('click', (event) => {
      if (event.target === els.fileInput) return;
      els.fileInput.click();
    });
    els.dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        els.fileInput.click();
      }
    });
    els.fileInput.addEventListener('change', () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = '';
      if (files.length) queueFiles(files);
    });

    let dragDepth = 0;
    els.dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      els.dropZone.classList.add('is-dragging');
    });
    els.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      els.dropZone.classList.add('is-dragging');
    });
    els.dropZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 || !els.dropZone.contains(event.relatedTarget)) {
        dragDepth = 0;
        els.dropZone.classList.remove('is-dragging');
      }
    });
    els.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      els.dropZone.classList.remove('is-dragging');
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) queueFiles(files);
    });

    // Dropping outside the target must never navigate away from the app.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    els.textInput.addEventListener('input', updateTextComposer);
    els.textInput.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        sendText();
      }
    });
    els.btnSendText.addEventListener('click', sendText);

    els.btnClearMessages.addEventListener('click', clearMessages);
    els.btnClearTransfers.addEventListener('click', clearFinishedTransfers);
    els.messageList.addEventListener('click', (event) => {
      const copyButton = event.target.closest('.message__copy');
      if (!copyButton) return;
      const message = copyButton.closest('.message');
      const text = message?.querySelector('.message__text')?.textContent || '';
      if (text) copyText(text, 'Text copied.');
    });

    els.transferList.addEventListener('click', (event) => {
      const action = event.target.closest('[data-transfer-action]');
      if (!action) return;
      const item = action.closest('.transfer');
      const key = item?.dataset.key;
      const transfer = key ? state.transfers.get(key) : null;
      if (!transfer) return;

      switch (action.dataset.transferAction) {
        case 'accept':
          acceptIncoming(transfer);
          break;
        case 'reject':
          rejectIncoming(transfer, 'User declined');
          break;
        case 'cancel':
          cancelTransfer(transfer);
          break;
        case 'remove':
          removeTransfer(transfer);
          break;
        default:
          break;
      }
    });

    window.addEventListener('beforeunload', () => {
      if (state.room && state.ws?.readyState === WebSocket.OPEN) {
        try {
          state.ws.send(JSON.stringify({ type: 'leave' }));
        } catch (error) {
          /* Best effort only. */
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  function initTheme() {
    const root = document.documentElement;
    const button = els.themeToggle;
    if (!button) return;

    const apply = (theme) => {
      root.dataset.theme = theme;
      const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      button.setAttribute('aria-label', label);
      button.title = label;
    };

    apply(root.dataset.theme === 'dark' ? 'dark' : 'light');

    button.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(next);
      try {
        window.localStorage.setItem('ishare:theme', next);
      } catch (error) {
        /* private mode */
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------------

  function connectSignaling() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    setSignalingState('connecting');

    let ws;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch (error) {
      handleSignalingClosed(null, true);
      return;
    }

    state.ws = ws;

    ws.addEventListener('open', () => {
      if (state.ws !== ws) return;
      state.reconnectAttempts = 0;
      setSignalingState('online');
      if (!state.room && state.pendingAutoJoin && !state.leaving) {
        const targetRoom = state.pendingAutoJoin;
        state.pendingAutoJoin = null;
        if (normalizeRoomCodeInput(els.roomInput.value) === targetRoom) {
          joinRoom();
        }
      }
      if (state.room && !state.leaving && !state.rejoinBlocked) {
        sendWs({
          type: 'join',
          room: state.room,
          name: state.selfName,
          clientId: state.selfId,
        });
      }
    });

    ws.addEventListener('message', (event) => {
      if (state.ws !== ws) return;
      handleServerMessage(event.data);
    });

    ws.addEventListener('error', () => {
      // close fires right after; it owns recovery.
    });

    ws.addEventListener('close', () => {
      if (state.ws !== ws) return;
      state.ws = null;
      handleSignalingClosed(ws, false);
    });
  }

  function handleSignalingClosed(ws, failedToCreate) {
    setSignalingState('offline');
    if (state.room) {
      for (const peer of state.peers.values()) peer.signalingOnline = false;
      renderPeerList();
      showOfflineBanner('Lost the signaling server. Active P2P transfers keep running; reconnecting…');
    }

    if (state.pendingRoomAction) {
      finishJoining();
      showLandingError('Could not reach the signaling server. Try reconnecting.');
    }

    if (!state.manualClose) scheduleSignalingReconnect(failedToCreate ? 1500 : 800);
  }

  function scheduleSignalingReconnect(delay) {
    if (state.manualClose || state.reconnectTimer) return;
    const backoff = Math.min(20_000, delay * 2 ** Math.min(state.reconnectAttempts, 4));
    state.reconnectAttempts += 1;
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connectSignaling();
    }, backoff);
  }

  function setSignalingState(mode) {
    state.signaling = mode;
    els.signalStatus.dataset.state = mode;
    const labels = {
      online: 'Server online',
      connecting: 'Connecting',
      offline: 'Server offline',
    };
    els.signalLabel.textContent = labels[mode] || mode;
  }

  function sendWs(payload) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('[signaling] send failed', error);
      return false;
    }
  }

  function sendSignal(to, signal) {
    return sendWs({ type: 'signal', to, signal });
  }

  function handleServerMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (error) {
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'joined':
        handleJoined(message);
        break;
      case 'peer-joined':
        handlePeerJoined(message.peer);
        break;
      case 'peer-online':
        handlePeerOnline(message.peer);
        break;
      case 'peer-offline':
        handlePeerOffline(message.peerId);
        break;
      case 'peer-left':
        handlePeerLeft(message.peerId);
        break;
      case 'signal':
        handleIncomingSignal(message);
        break;
      case 'error':
        handleServerError(message);
        break;
      case 'left':
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  function handleServerError(message) {
    const code = typeof message.code === 'string' ? message.code : 'ERROR';
    const text = typeof message.message === 'string' ? message.message : 'An unexpected server error occurred.';

    if (state.pendingRoomAction) {
      if (code === 'ROOM_NOT_FOUND') clearSessionRoom();
      finishJoining();
      showLandingError(text);
      return;
    }

    if (state.room && (code === 'ROOM_NOT_FOUND' || code === 'ID_TAKEN')) {
      state.rejoinBlocked = true;
      showOfflineBanner('The signaling room no longer exists. Existing P2P connections can keep working.');
      toast(text, 'error', 7000);
      return;
    }

    if (code === 'PEER_UNAVAILABLE') {
      return;
    }

    toast(text, 'error');
  }

  function createRoom() {
    if (!ensureSignalingReady()) return;
    const name = resolveDisplayName();
    state.pendingRoomAction = 'create';
    armJoinTimer();
    setJoinBusy(true);
    hideLandingError();
    if (!sendWs({ type: 'create', name, clientId: state.selfId })) {
      finishJoining();
      showLandingError('Could not connect to the signaling server.');
    }
  }

  function joinRoom() {
    if (!ensureSignalingReady()) return;
    const code = normalizeRoomCodeInput(els.roomInput.value);
    if (code.length !== ROOM_CODE_LENGTH) {
      showLandingError('Room codes are 6 characters. Example: K7M2QX');
      els.roomInput.focus();
      return;
    }
    const name = resolveDisplayName();
    state.pendingRoomAction = 'join';
    armJoinTimer();
    setJoinBusy(true);
    hideLandingError();
    els.roomInput.value = code;
    if (!sendWs({ type: 'join', room: code, name, clientId: state.selfId })) {
      finishJoining();
      showLandingError('Could not connect to the signaling server.');
    }
  }

  function ensureSignalingReady() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return true;
    if (!state.ws) connectSignaling();
    showLandingError('Connecting to the signaling server. Try again in a few seconds.');
    return false;
  }

  function armJoinTimer() {
    clearTimeout(state.joinTimer);
    state.joinTimer = window.setTimeout(() => {
      if (!state.pendingRoomAction) return;
      finishJoining();
      showLandingError('The server did not respond. Please try again.');
    }, 12_000);
  }

  function finishJoining() {
    clearTimeout(state.joinTimer);
    state.joinTimer = null;
    state.pendingRoomAction = null;
    setJoinBusy(false);
  }

  function setJoinBusy(busy) {
    els.btnCreate.disabled = busy;
    els.btnJoin.disabled = busy;
    els.btnCreate.classList.toggle('is-busy', busy);
    els.btnJoin.classList.toggle('is-busy', busy);
  }

  function resolveDisplayName() {
    let name = cleanName(els.deviceName.value, 32);
    if (!name) name = suggestDeviceName();
    els.deviceName.value = name;
    state.selfName = name;
    storeName(name);
    return name;
  }

  function handleJoined(message) {
    if (!message || typeof message.room !== 'string' || !message.self) return;
    const wasCreate = state.pendingRoomAction === 'create';
    const wasResume = Boolean(message.resumed);
    const previousRoom = state.room;

    finishJoining();
    hideLandingError();
    hideOfflineBanner();
    state.rejoinBlocked = false;
    state.pendingAutoJoin = null;

    if (previousRoom && previousRoom !== message.room) {
      closeAllPeers('Room changed');
      clearRoomLists();
    }

    state.room = message.room;
    storeSessionRoom(state.room);
    state.selfId = isSafeId(message.self.id) ? message.self.id : state.selfId;
    storeClientId(state.selfId);
    state.selfName = cleanName(message.self.name, 32) || state.selfName || suggestDeviceName();
    state.maxPeers = Number.isInteger(message.maxPeers) ? message.maxPeers : state.maxPeers;

    els.roomCodeDisplay.textContent = state.room;
    els.roomInput.value = state.room;
    updateRoomUrl(state.room);
    showRoomView();

    const announcedIds = new Set();
    const incomingPeers = Array.isArray(message.peers) ? message.peers : [];
    for (const peerInfo of incomingPeers) {
      if (!peerInfo || !isSafeId(peerInfo.id) || peerInfo.id === state.selfId) continue;
      announcedIds.add(peerInfo.id);
      upsertPeer(peerInfo);
    }

    for (const peerId of [...state.peers.keys()]) {
      if (!announcedIds.has(peerId)) destroyPeer(peerId, 'Device is not in the room');
    }

    renderPeerList();

    // The peer that joins (or rejoins) initiates. Existing peers answer. This
    // deterministic rule avoids WebRTC offer glare without extra negotiation.
    for (const peer of state.peers.values()) {
      if (peer.dc && peer.dc.readyState === 'open') continue;
      // A rejoin means we are the initiating side again. Drop any half-built
      // transport so a lost offer or stale ICE generation cannot wedge the
      // negotiation; the other side will answer our fresh offer.
      if (peer.pc) {
        cancelPeerTransfers(peer, 'Reconnecting');
        closePeerTransport(peer);
      }
      peer.connectAttempts = 0;
      peer.gaveUp = false;
      beginInitiator(peer);
    }

    if (wasCreate) {
      toast('Room ready. Share the code or invite link.', 'success', 4500);
    } else if (wasResume) {
      toast('Signaling connection restored.', 'success');
    }
  }

  function handlePeerJoined(peerInfo) {
    if (!peerInfo || !isSafeId(peerInfo.id) || peerInfo.id === state.selfId) return;
    const existed = state.peers.has(peerInfo.id);
    const peer = upsertPeer(peerInfo);
    if (!peer) return;
    renderPeerList();
    if (!existed) {
      toast(`${peer.name} joined the room.`);
    }
  }

  function handlePeerOnline(peerInfo) {
    if (!peerInfo || !isSafeId(peerInfo.id)) return;
    const peer = upsertPeer(peerInfo);
    if (!peer) return;
    renderPeerList();
  }

  function handlePeerOffline(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    peer.signalingOnline = false;
    renderPeerList();
  }

  function handlePeerLeft(peerId) {
    if (!peerId) return;
    destroyPeer(peerId, 'Device left the room');
  }

  function upsertPeer(peerInfo) {
    if (!peerInfo || !isSafeId(peerInfo.id) || peerInfo.id === state.selfId) return null;
    let peer = state.peers.get(peerInfo.id);
    if (!peer) {
      peer = {
        id: peerInfo.id,
        name: cleanName(peerInfo.name, 32) || 'Unknown device',
        signalingOnline: true,
        pc: null,
        dc: null,
        initiator: false,
        initiating: false,
        remoteCandidates: [],
        restartAttempted: false,
        restartTimer: null,
        connectTimer: null,
        disconnectTimer: null,
        connectAttempts: 0,
        gaveUp: false,
        route: 'unknown',
        routeDetail: '',
        incoming: null,
        sendQueue: [],
        sending: false,
        activeSend: null,
        destroyed: false,
      };
      state.peers.set(peer.id, peer);
      state.selectedPeers.add(peer.id);
    } else {
      peer.name = cleanName(peerInfo.name, 32) || peer.name;
      peer.signalingOnline = true;
    }
    return peer;
  }

  function destroyPeer(peerId, reason) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    peer.destroyed = true;
    peer.signalingOnline = false;
    clearPeerTimers(peer);
    cancelPeerTransfers(peer, reason || 'Connection closed');
    closePeerTransport(peer);
    state.peers.delete(peerId);
    state.selectedPeers.delete(peerId);
    renderPeerList();
  }

  function closeAllPeers(reason) {
    for (const peerId of [...state.peers.keys()]) destroyPeer(peerId, reason);
  }

  function clearPeerTimers(peer) {
    if (peer.restartTimer) {
      clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
    }
    if (peer.connectTimer) {
      clearTimeout(peer.connectTimer);
      peer.connectTimer = null;
    }
    if (peer.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
  }

  function closePeerTransport(peer) {
    clearPeerTimers(peer);
    if (peer.dc) {
      try {
        peer.dc.close();
      } catch (error) {
        /* already closed */
      }
      peer.dc = null;
    }
    if (peer.pc) {
      try {
        peer.pc.close();
      } catch (error) {
        /* already closed */
      }
      peer.pc = null;
    }
    peer.remoteCandidates = [];
    peer.incoming = null;
    peer.activeSend = null;
    peer.sending = false;
    peer.route = 'unknown';
    peer.routeDetail = '';
  }

  function showRoomView() {
    els.viewLanding.hidden = true;
    els.viewRoom.hidden = false;
    document.title = `${state.room} · iShare`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showLandingView() {
    els.viewRoom.hidden = true;
    els.viewLanding.hidden = false;
    document.title = 'iShare — send files between browsers';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    state.selfId = createId();
    storeClientId(state.selfId);
  }

  function updateRoomUrl(room) {
    try {
      const url = new URL(window.location.href);
      if (room) url.searchParams.set('room', room);
      else url.searchParams.delete('room');
      url.hash = '';
      window.history.replaceState({}, '', url);
    } catch (error) {
      /* file:// and some embedded contexts */
    }
  }

  function roomUrl() {
    try {
      const url = new URL(window.location.href);
      if (state.room) url.searchParams.set('room', state.room);
      url.hash = '';
      return url.toString();
    } catch (error) {
      return window.location.href;
    }
  }

  function hydrateRoomFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = normalizeRoomCodeInput(params.get('room') || '');
      if (code.length === ROOM_CODE_LENGTH) {
        els.roomInput.value = code;
        els.inviteHint.hidden = false;
        // Reloading a tab that was in this room should resume the session
        // instead of asking the user to join again.
        if (readSessionRoom() === code) state.pendingAutoJoin = code;
        else els.roomInput.focus({ preventScroll: true });
      }
    } catch (error) {
      /* ignore malformed URLs */
    }
  }

  function renderPeerList() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(buildSelfRow());

    const peers = [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    for (const peer of peers) {
      const li = els.peerTemplate.content.firstElementChild.cloneNode(true);
      const ui = peerUiState(peer);
      li.dataset.peerId = peer.id;
      li.dataset.state = ui.state;

      const button = li.querySelector('.peer__button');
      const avatar = li.querySelector('.peer__avatar');
      const name = li.querySelector('.peer__name');
      const status = li.querySelector('.peer__status');

      button.setAttribute('aria-pressed', String(state.selectedPeers.has(peer.id)));
      button.setAttribute(
        'aria-label',
        `${peer.name}, ${ui.label}. ${
          ui.state === 'online' ? 'Toggle this device.' : 'Use the button beside this to reconnect.'
        }`,
      );
      avatar.textContent = initialOf(peer.name);
      avatar.dataset.tone = String(hashTone(peer.id));
      name.textContent = peer.name;
      name.title = peer.name;
      status.textContent = ui.label;
      status.title = ui.title || '';

      const retry = li.querySelector('.peer__retry');
      retry.hidden = ui.state === 'online';
      retry.setAttribute('aria-label', `Reconnect ${peer.name}`);
      retry.title = 'Reconnect';
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        retryPeer(peer);
      });

      fragment.appendChild(li);
    }

    els.peerList.replaceChildren(fragment);
    updateRoomStats();
  }

  function buildSelfRow() {
    const li = document.createElement('li');
    li.className = 'peer peer--self';
    li.dataset.state = 'online';

    const row = document.createElement('div');
    row.className = 'peer__button';

    const avatar = document.createElement('span');
    avatar.className = 'peer__avatar peer__avatar--self';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initialOf(state.selfName || 'You');

    const copy = document.createElement('span');
    copy.className = 'peer__copy';
    const name = document.createElement('span');
    name.className = 'peer__name';
    name.textContent = state.selfName || 'This device';
    name.title = name.textContent;
    const badge = document.createElement('span');
    badge.className = 'peer-self-badge';
    badge.textContent = 'YOU';
    name.appendChild(document.createTextNode(' '));
    name.appendChild(badge);

    const meta = document.createElement('span');
    meta.className = 'peer__meta';
    const dot = document.createElement('span');
    dot.className = 'peer__dot';
    dot.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'peer__status';
    status.textContent = 'This device';
    meta.append(dot, status);

    copy.append(name, meta);

    const check = document.createElement('span');
    check.className = 'peer__check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    row.append(avatar, copy, check);
    li.appendChild(row);
    return li;
  }

  function updateRoomStats() {
    const connected = connectedPeers().length;
    const total = state.peers.size;

    if (total === 0) els.peerCount.textContent = 'just you';
    else if (connected === 0) els.peerCount.textContent = `${total} waiting`;
    else els.peerCount.textContent = `${connected} connected`;

    if (state.signaling !== 'online' && connected === 0) {
      els.meshLabel.textContent = 'No signal';
    } else if (state.signaling !== 'online') {
      els.meshLabel.textContent = 'P2P running';
    } else if (connected > 0) {
      els.meshLabel.textContent = `Mesh active · ${connected + 1} devices`;
    } else {
      els.meshLabel.textContent = 'Waiting for signal';
    }

    updateTargetSummary();
    updateSendAvailability();
  }

  function updateTargetSummary() {
    const targets = selectedConnectedPeers();
    els.targetSummary.classList.toggle('is-idle', targets.length === 0);

    if (state.peers.size === 0) {
      els.targetText.textContent = 'Looking for a device…';
      return;
    }
    if (targets.length === 0) {
      els.targetText.textContent =
        state.selectedPeers.size > 0 ? 'Waiting for a device to connect…' : 'No target selected';
      return;
    }
    if (targets.length === 1) {
      els.targetText.textContent = `Target: ${targets[0].name}`;
      return;
    }
    els.targetText.textContent = `Sending to ${targets.length} devices`;
  }

  function togglePeerSelection(peerId) {
    if (!state.peers.has(peerId)) return;
    if (state.selectedPeers.has(peerId)) state.selectedPeers.delete(peerId);
    else state.selectedPeers.add(peerId);
    renderPeerList();
  }

  function peerUiState(peer) {
    if (peer.dc && peer.dc.readyState === 'open') {
      let label = 'Connected';
      let title = 'Connection ready.';
      if (peer.route === 'relay') {
        label = 'Connected · relay';
        title = 'Traffic is relayed through the TURN server (end-to-end DTLS encrypted).';
      } else if (peer.route === 'direct') {
        label = 'Connected · direct';
        title = 'Direct browser-to-browser connection.';
      }
      if (!peer.signalingOnline) label += ' · no signal';
      return { state: 'online', label, title };
    }
    if (peer.gaveUp) {
      return {
        state: 'offline',
        label: 'Could not connect',
        title: 'The network may be blocking P2P. Try again with the retry button; if needed, configure TURN on the server.',
      };
    }
    if (peer.pc && peer.pc.connectionState === 'failed') {
      return {
        state: 'offline',
        label: 'Connection lost',
        title: 'Connection lost. Use the retry button to reconnect.',
      };
    }
    if (peer.pc && peer.pc.connectionState === 'disconnected') {
      return {
        state: 'connecting',
        label: 'Weak connection',
        title: 'The connection weakened; trying to recover.',
      };
    }
    if (peer.pc && peer.pc.connectionState === 'connected') {
      return { state: 'connecting', label: 'Opening channel', title: 'WebRTC connected, opening the data channel.' };
    }
    if (peer.pc && peer.pc.connectionState === 'closed') {
      return { state: 'offline', label: 'Connection closed', title: 'Connection closed. Use the retry button to reconnect.' };
    }
    return { state: 'connecting', label: 'Handshaking', title: 'WebRTC handshake in progress.' };
  }

  function connectedPeers() {
    return [...state.peers.values()].filter(
      (peer) => !peer.destroyed && peer.dc && peer.dc.readyState === 'open',
    );
  }

  function selectedConnectedPeers() {
    return connectedPeers().filter((peer) => state.selectedPeers.has(peer.id));
  }

  // ---------------------------------------------------------------------------
  // WebRTC negotiation
  // ---------------------------------------------------------------------------

  async function ensurePeerConnection(peer, initiator) {
    if (peer.pc && !['failed', 'closed'].includes(peer.pc.connectionState)) {
      return peer.pc;
    }
    if (peer.pc) closePeerTransport(peer);

    // Short-lived TURN credentials must be renewed before a new transport is
    // created; an expired credential makes every relay candidate fail.
    if (state.config.iceExpiresAt && Date.now() > state.config.iceExpiresAt - 60_000) {
      state.configPromise = loadConfig();
    }
    if (!state.configPromise) state.configPromise = loadConfig();
    await state.configPromise;

    const pc = new RTCPeerConnection({
      iceServers: state.config.iceServers,
      iceTransportPolicy: state.config.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
    });

    peer.pc = pc;
    peer.initiator = initiator;
    peer.restartAttempted = false;
    peer.gaveUp = false;

    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      if (state.peers.get(peer.id) !== peer) return;
      const candidate = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      };
      sendSignal(peer.id, { kind: 'candidate', candidate });
    });

    pc.addEventListener('connectionstatechange', () => {
      if (peer.pc !== pc) return;
      renderPeerList();
      if (pc.connectionState === 'connected') {
        peer.restartAttempted = false;
        peer.connectAttempts = 0;
        peer.gaveUp = false;
        if (peer.connectTimer) {
          clearTimeout(peer.connectTimer);
          peer.connectTimer = null;
        }
        if (peer.disconnectTimer) {
          clearTimeout(peer.disconnectTimer);
          peer.disconnectTimer = null;
        }
        window.setTimeout(() => detectPeerRoute(peer, pc), 300);
      } else if (pc.connectionState === 'failed') {
        maybeRestartPeer(peer);
      } else if (pc.connectionState === 'disconnected') {
        // A transient Wi-Fi handover recovers on its own. Give it a few
        // seconds before forcing an ICE restart.
        if (!peer.disconnectTimer) {
          peer.disconnectTimer = window.setTimeout(() => {
            peer.disconnectTimer = null;
            if (peer.pc === pc && peer.dc?.readyState !== 'open' && pc.connectionState !== 'connected') {
              maybeRestartPeer(peer);
            }
          }, 4000);
        }
      } else if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (peer.pc !== pc) return;
      renderPeerList();
      if (pc.iceConnectionState === 'failed') maybeRestartPeer(peer);
    });

    pc.addEventListener('icecandidateerror', (event) => {
      if (peer.pc !== pc) return;
      // Most of these are harmless (one STUN/TURN address unreachable while
      // another succeeds), but they are invaluable when diagnosing NATs.
      console.warn('[webrtc] ICE candidate error', event.errorCode || '', event.url || '');
    });

    pc.addEventListener('datachannel', (event) => {
      if (peer.pc !== pc) return;
      bindDataChannel(peer, event.channel);
    });

    if (initiator) {
      const channel = pc.createDataChannel('ishare', { ordered: true });
      bindDataChannel(peer, channel);
    }

    return pc;
  }

  async function beginInitiator(peer) {
    if (peer.initiating || peer.destroyed) return;
    if (peer.dc && peer.dc.readyState === 'open') return;
    if (state.peers.get(peer.id) !== peer) return;
    peer.initiating = true;
    try {
      const pc = await ensurePeerConnection(peer, true);
      if (pc.signalingState !== 'stable' || state.peers.get(peer.id) !== peer) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peer.id, { kind: 'offer', sdp: pc.localDescription.sdp });
      armConnectWatchdog(peer, pc);
    } catch (error) {
      console.warn('[webrtc] offer failed', error);
      notifyPeerFailure(peer);
    } finally {
      peer.initiating = false;
    }
  }

  async function handleIncomingSignal(message) {
    const from = message.from;
    const signal = message.signal;
    if (!isSafeId(from) || !signal || typeof signal !== 'object') return;

    let peer = state.peers.get(from);
    if (!peer) {
      peer = upsertPeer({ id: from, name: 'New device' });
      if (!peer) return;
      renderPeerList();
    }

    try {
      if (signal.kind === 'offer') {
        await handleRemoteOffer(peer, signal.sdp);
      } else if (signal.kind === 'answer') {
        await handleRemoteAnswer(peer, signal.sdp);
      } else if (signal.kind === 'candidate') {
        await handleRemoteCandidate(peer, signal.candidate);
      }
    } catch (error) {
      console.warn('[webrtc] signal handling failed', error);
      notifyPeerFailure(peer);
    }
  }

  async function handleRemoteOffer(peer, sdp) {
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) return;
    const channelOpen = Boolean(peer.dc && peer.dc.readyState === 'open');
    if (peer.pc && !channelOpen) {
      // An offer without an open channel means the remote tab reloaded or
      // rebuilt its PeerConnection, so the local transport is stale.
      cancelPeerTransfers(peer, 'WebRTC connection reconnecting');
      closePeerTransport(peer);
    }

    const pc = await ensurePeerConnection(peer, false);
    peer.connectAttempts = 0;
    peer.gaveUp = false;

    if (pc.signalingState === 'have-local-offer') {
      await pc.setLocalDescription({ type: 'rollback' });
    }
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') {
      throw new Error(`Unexpected signaling state: ${pc.signalingState}`);
    }

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await flushRemoteCandidates(peer, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (state.peers.get(peer.id) !== peer) return;
    sendSignal(peer.id, { kind: 'answer', sdp: pc.localDescription.sdp });
  }

  async function handleRemoteAnswer(peer, sdp) {
    const pc = peer.pc;
    if (!pc || typeof sdp !== 'string') return;
    if (pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await flushRemoteCandidates(peer, pc);
  }

  async function handleRemoteCandidate(peer, candidate) {
    if (!candidate) return;
    const pc = peer.pc;
    if (!pc) {
      peer.remoteCandidates.push(candidate);
      return;
    }
    if (!pc.remoteDescription) {
      peer.remoteCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('[webrtc] candidate rejected', error);
    }
  }

  async function flushRemoteCandidates(peer, pc) {
    if (!pc.remoteDescription) return;
    const queued = peer.remoteCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('[webrtc] queued candidate rejected', error);
      }
    }
  }

  function maybeRestartPeer(peer) {
    if (!peer.initiator || !peer.pc || peer.restartAttempted || peer.restartTimer) return;
    if (state.signaling !== 'online') return;
    peer.restartAttempted = true;
    peer.restartTimer = window.setTimeout(async () => {
      peer.restartTimer = null;
      if (peer.destroyed || !peer.pc || peer.dc?.readyState === 'open') return;
      try {
        if (typeof peer.pc.restartIce === 'function') peer.pc.restartIce();
        const offer = await peer.pc.createOffer({ iceRestart: true });
        await peer.pc.setLocalDescription(offer);
        sendSignal(peer.id, { kind: 'offer', sdp: peer.pc.localDescription.sdp });
        armConnectWatchdog(peer, peer.pc);
      } catch (error) {
        console.warn('[webrtc] ICE restart failed', error);
      }
    }, 2500);
  }

  /**
   * A cross-network handshake can fail silently: the offer is delivered but no
   * ICE pair ever succeeds (blocked UDP, expired TURN credential, asymmetric
   * NAT). Rebuild the transport a couple of times before surfacing a manual
   * retry, instead of leaving the peer stuck on "Handshaking" forever.
   */
  function armConnectWatchdog(peer, pc) {
    if (!peer || peer.destroyed || peer.dc?.readyState === 'open') return;
    if (peer.connectTimer) clearTimeout(peer.connectTimer);
    peer.connectTimer = window.setTimeout(() => {
      peer.connectTimer = null;
      if (peer.destroyed || peer.pc !== pc || peer.dc?.readyState === 'open') return;
      if (state.signaling !== 'online') {
        // Without signaling a retry cannot reach the other side. Wait for the
        // reconnect handler to renegotiate.
        armConnectWatchdog(peer, pc);
        return;
      }
      peer.connectAttempts += 1;
      if (peer.connectAttempts <= MAX_CONNECT_ATTEMPTS) {
        console.warn(`[webrtc] no connection after ${CONNECT_TIMEOUT_MS}ms; rebuilding transport (attempt ${peer.connectAttempts})`);
        cancelPeerTransfers(peer, 'Reconnecting');
        closePeerTransport(peer);
        beginInitiator(peer);
      } else {
        peer.gaveUp = true;
        renderPeerList();
        notifyPeerFailure(peer);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function retryPeer(peer) {
    if (!peer || peer.destroyed) return;
    peer.connectAttempts = 0;
    peer.gaveUp = false;
    peer.failureNotified = false;
    cancelPeerTransfers(peer, 'Reconnecting');
    closePeerTransport(peer);
    renderPeerList();
    beginInitiator(peer);
    toast(`Reconnecting to ${peer.name}…`, 'info', 2600);
  }

  async function detectPeerRoute(peer, pc) {
    if (!peer || peer.pc !== pc || peer.dc?.readyState !== 'open') return;
    try {
      const stats = await pc.getStats();
      let pair = null;
      let selectedPairId = null;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }
      });
      stats.forEach((report) => {
        if (pair || report.type !== 'candidate-pair' || report.state !== 'succeeded') return;
        if (report.selected || report.nominated || report.id === selectedPairId) pair = report;
      });
      if (!pair && selectedPairId) pair = stats.get(selectedPairId);
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      peer.route = relay ? 'relay' : 'direct';
      peer.routeDetail = `${local?.candidateType || '?'} ↔ ${remote?.candidateType || '?'}`;
      renderPeerList();
    } catch (error) {
      /* getStats is optional; the plain "Connected" label remains accurate */
    }
  }

  function bindDataChannel(peer, channel) {
    if (!channel) return;
    if (peer.dc && peer.dc !== channel) {
      try {
        peer.dc.close();
      } catch (error) {
        /* already closed */
      }
    }

    peer.dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    channel.addEventListener('open', () => {
      if (peer.dc !== channel) return;
      peer.connectAttempts = 0;
      peer.gaveUp = false;
      if (peer.connectTimer) {
        clearTimeout(peer.connectTimer);
        peer.connectTimer = null;
      }
      if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      }
      renderPeerList();
      sendControl(peer, {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
      });
      detectPeerRoute(peer, peer.pc);
    });

    channel.addEventListener('close', () => {
      if (peer.dc !== channel) return;
      peer.dc = null;
      cancelPeerTransfers(peer, 'Data channel closed');
      renderPeerList();
    });

    channel.addEventListener('error', () => {
      if (peer.dc !== channel) return;
      renderPeerList();
    });

    channel.addEventListener('message', (event) => {
      if (peer.dc !== channel) return;
      handleDataMessage(peer, event.data);
    });
  }

  function notifyPeerFailure(peer) {
    if (!peer || peer.destroyed) return;
    if (peer.failureNotified) return;
    peer.failureNotified = true;
    toast(
      `${peer.name}: the P2P connection failed. Try again with the retry button in the device list; strict or corporate networks need TURN configured on the server.`,
      'error',
      9000,
    );
    window.setTimeout(() => {
      peer.failureNotified = false;
    }, 12_000);
  }

  // ---------------------------------------------------------------------------
  // DataChannel protocol
  // ---------------------------------------------------------------------------

  function sendControl(peer, payload) {
    const channel = peer?.dc;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('[datachannel] control send failed', error);
      return false;
    }
  }

  function handleDataMessage(peer, data) {
    if (typeof data === 'string') {
      if (data.length > 64 * 1024) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch (error) {
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      handleControlMessage(peer, message);
      return;
    }

    if (data instanceof ArrayBuffer) {
      handleIncomingChunk(peer, data);
      return;
    }

    if (data instanceof Blob) {
      if (data.size > 256 * 1024) return;
      data
        .arrayBuffer()
        .then((buffer) => handleIncomingChunk(peer, buffer))
        .catch(() => {
          /* A closed channel can cancel the Blob conversion. */
        });
    }
  }

  function handleControlMessage(peer, message) {
    if (!protocol.CONTROL_TYPES.includes(message.type)) return;
    switch (message.type) {
      case 'hello':
        if (message.protocol !== PROTOCOL_VERSION) {
          toast(`${peer.name} is using an incompatible client version.`, 'error');
        }
        break;

      case 'text':
        handleIncomingText(peer, message);
        break;

      case 'file-start':
        startIncomingFile(peer, message);
        break;

      case 'file-accept':
        handleFileAccept(peer, message.id);
        break;

      case 'file-reject':
        handleFileReject(peer, message.id, message.reason);
        break;

      case 'file-end':
        completeIncoming(peer, message.id);
        break;

      case 'file-complete':
        handleFileComplete(peer, message.id);
        break;

      case 'file-error':
        handleFileError(peer, message.id, message.reason);
        break;

      case 'file-cancel':
        handleFileCancel(peer, message.id, message.reason);
        break;

      default:
        break;
    }
  }

  function handleIncomingText(peer, message) {
    if (typeof message.text !== 'string') return;
    const text = message.text.slice(0, MAX_TEXT_LENGTH);
    if (!text.trim()) return;
    const at = Number.isFinite(message.at) ? message.at : Date.now();
    addMessage({
      sender: peer.name,
      text,
      at,
      outgoing: false,
    });
  }

  function startIncomingFile(peer, message) {
    if (!isSafeId(message.id)) return;

    if (peer.incoming) {
      if (message.id !== peer.incoming.protocolId) {
        sendControl(peer, { type: 'file-reject', id: message.id, reason: 'Device is already receiving another file' });
      }
      return;
    }

    const size = Number(message.size);
    const name = sanitizeFileName(message.name);
    const mime = sanitizeMime(message.mime);
    if (protocol.validateFileSize(size, MAX_FILE_BYTES)) {
      sendControl(peer, { type: 'file-reject', id: message.id, reason: 'Invalid file size' });
      return;
    }

    const key = `in:${peer.id}:${message.id}`;
    if (state.transfers.has(key)) {
      sendControl(peer, { type: 'file-reject', id: message.id, reason: 'Transfer already in progress' });
      return;
    }

    const transfer = {
      key,
      protocolId: message.id,
      direction: 'in',
      peerId: peer.id,
      peerName: peer.name,
      name,
      size,
      mime,
      file: null,
      status: 'incoming',
      bytes: 0,
      speed: 0,
      error: null,
      cancelled: false,
      storage: null,
      writable: null,
      writeChain: Promise.resolve(),
      writeError: null,
      chunks: [],
      downloadUrl: null,
      fileName: name,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      lastSampleAt: null,
      lastSampleBytes: 0,
      lastUiAt: 0,
      el: null,
      lastRenderedStatus: null,
      accepting: false,
    };

    state.transfers.set(key, transfer);
    peer.incoming = transfer;
    renderTransfer(transfer);
    updateTargetSummary();
  }

  async function acceptIncoming(transfer) {
    if (!transfer || transfer.direction !== 'in' || transfer.status !== 'incoming' || transfer.accepting) return;
    const peer = state.peers.get(transfer.peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') {
      rejectIncoming(transfer, 'Device not connected');
      return;
    }

    transfer.accepting = true;
    transfer.status = 'preparing';
    updateTransferUI(transfer, true);

    let writable = null;
    if (typeof window.showSaveFilePicker === 'function' && window.isSecureContext) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: transfer.name });
        writable = await handle.createWritable();
        transfer.fileName = handle.name || transfer.name;
        transfer.storage = 'disk';
      } catch (error) {
        if (error && error.name === 'AbortError') {
          transfer.accepting = false;
          rejectIncoming(transfer, 'Save cancelled', { sendReject: true });
          return;
        }
        console.warn('[receive] direct-to-disk unavailable, using memory', error);
        writable = null;
      }
    }

    transfer.accepting = false;
    if (state.peers.get(transfer.peerId) !== peer || peer.destroyed || transfer.status !== 'preparing') {
      if (writable) {
        try {
          await writable.abort();
        } catch (error) {
          /* picker was already closed */
        }
      }
      return;
    }
    if (!writable) {
      transfer.storage = 'memory';
      transfer.chunks = [];
      transfer.fileName = transfer.name;
    }

    transfer.writable = writable;
    transfer.status = 'receiving';
    transfer.startedAt = performance.now();
    transfer.lastSampleAt = transfer.startedAt;
    transfer.lastSampleBytes = 0;
    updateTransferUI(transfer, true);

    if (!sendControl(peer, { type: 'file-accept', id: transfer.protocolId })) {
      await abortIncoming(transfer);
      failIncoming(transfer, 'Data channel closed', { notifyPeer: false });
    }
  }

  function rejectIncoming(transfer, reason, options = {}) {
    if (!transfer || transfer.direction !== 'in') return;
    if (!['incoming', 'preparing'].includes(transfer.status)) return;
    const peer = state.peers.get(transfer.peerId);
    if (peer && options.sendReject !== false) {
      sendControl(peer, {
        type: 'file-reject',
        id: transfer.protocolId,
        reason: String(reason || 'Declined').slice(0, 120),
      });
    }
    if (peer?.incoming === transfer) peer.incoming = null;
    transfer.status = 'rejected';
    transfer.error = reason || 'Declined';
    transfer.accepting = false;
    updateTransferUI(transfer, true);
  }

  function handleIncomingChunk(peer, buffer) {
    const transfer = peer.incoming;
    if (!transfer || !(buffer instanceof ArrayBuffer)) return;
    const problem = protocol.validateIncomingChunk(transfer, buffer.byteLength);
    if (problem === 'chunk-too-large') {
      failIncoming(transfer, 'Invalid data chunk');
      return;
    }
    if (problem === 'size-overflow') {
      failIncoming(transfer, 'File size exceeded');
      return;
    }
    if (problem === 'write-error') {
      failIncoming(transfer, 'Could not write to disk');
      return;
    }
    if (problem) return;

    transfer.bytes += buffer.byteLength;

    if (transfer.storage === 'disk' && transfer.writable) {
      const chunk = buffer;
      transfer.writeChain = transfer.writeChain.then(async () => {
        if (transfer.cancelled || transfer.writeError) return;
        try {
          await transfer.writable.write(chunk);
        } catch (error) {
          transfer.writeError = error;
        }
      });
    } else {
      transfer.chunks.push(buffer);
    }

    sampleTransferSpeed(transfer);
    const now = performance.now();
    if (now - transfer.lastUiAt > 90) {
      transfer.lastUiAt = now;
      updateTransferUI(transfer);
    }
  }

  async function completeIncoming(peer, protocolId) {
    const transfer = peer.incoming;
    if (!transfer || transfer.protocolId !== protocolId) return;
    if (transfer.bytes !== transfer.size) {
      failIncoming(transfer, 'Transfer finished incomplete');
      return;
    }

    transfer.status = 'processing';
    updateTransferUI(transfer, true);

    try {
      await transfer.writeChain;
      if (transfer.cancelled) return;
      if (transfer.writeError) throw transfer.writeError;

      if (transfer.storage === 'disk' && transfer.writable) {
        await transfer.writable.close();
        transfer.writable = null;
      } else {
        const blob = new Blob(transfer.chunks, { type: transfer.mime || 'application/octet-stream' });
        transfer.chunks = [];
        transfer.downloadUrl = URL.createObjectURL(blob);
      }

      if (peer.incoming === transfer) peer.incoming = null;
      transfer.status = 'complete';
      transfer.completedAt = Date.now();
      transfer.speed = 0;
      updateTransferUI(transfer, true);
      sendControl(peer, { type: 'file-complete', id: transfer.protocolId });

      if (transfer.storage === 'disk') {
        toast(`${transfer.fileName} kaydedildi.`, 'success', 4000);
      } else {
        toast(`${transfer.name} is ready. Starting the download.`, 'success', 4000);
        triggerDownload(transfer);
      }
    } catch (error) {
      console.warn('[receive] finalize failed', error);
      if (peer.incoming === transfer) peer.incoming = null;
      transfer.status = 'error';
      transfer.error = 'Could not save the file';
      updateTransferUI(transfer, true);
      sendControl(peer, { type: 'file-error', id: transfer.protocolId, reason: 'save-failed' });
      await abortIncoming(transfer);
    }
  }

  async function failIncoming(transfer, reason, options = {}) {
    if (!transfer || transfer.direction !== 'in') return;
    if (['complete', 'error', 'cancelled', 'rejected'].includes(transfer.status)) return;
    const peer = state.peers.get(transfer.peerId);
    if (peer?.incoming === transfer) peer.incoming = null;
    transfer.status = 'error';
    transfer.error = reason || 'Transfer failed';
    transfer.accepting = false;
    updateTransferUI(transfer, true);
    if (options.notifyPeer !== false && peer) {
      sendControl(peer, {
        type: 'file-cancel',
        id: transfer.protocolId,
        reason: 'receive-error',
      });
    }
    await abortIncoming(transfer);
  }

  async function abortIncoming(transfer) {
    if (!transfer) return;
    try {
      await transfer.writeChain;
    } catch (error) {
      /* already captured */
    }
    if (transfer.writable) {
      try {
        await transfer.writable.abort();
      } catch (error) {
        /* stream may already be closed */
      }
      transfer.writable = null;
    }
    transfer.chunks = [];
  }

  function triggerDownload(transfer) {
    if (!transfer.downloadUrl) return;
    try {
      const anchor = document.createElement('a');
      anchor.href = transfer.downloadUrl;
      anchor.download = transfer.fileName || transfer.name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      /* The explicit download button remains available. */
    }
  }

  // ---------------------------------------------------------------------------
  // Outgoing files
  // ---------------------------------------------------------------------------

  function queueFiles(files) {
    if (!state.room) return;
    const targets = selectedConnectedPeers();
    if (targets.length === 0) {
      toast('Select at least one connected device first.', 'error');
      return;
    }

    const validFiles = files.filter((file) => file && typeof file.name === 'string' && Number.isFinite(file.size));
    if (validFiles.length === 0) return;

    let queued = 0;
    let skipped = 0;

    for (const peer of targets) {
      for (const file of validFiles) {
        if (file.size > MAX_FILE_BYTES) {
          skipped += 1;
          continue;
        }
        const protocolId = createId();
        const key = `out:${peer.id}:${protocolId}`;
        const transfer = {
          key,
          protocolId,
          direction: 'out',
          peerId: peer.id,
          peerName: peer.name,
          name: sanitizeFileName(file.name),
          size: file.size,
          mime: sanitizeMime(file.type),
          file,
          status: 'queued',
          bytes: 0,
          speed: 0,
          error: null,
          cancelled: false,
          delivered: false,
          unconfirmed: false,
          rejectReason: null,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          lastSampleAt: null,
          lastSampleBytes: 0,
          lastUiAt: 0,
          acceptResolve: null,
          acceptTimer: null,
          completeResolve: null,
          ackTimer: null,
          el: null,
          lastRenderedStatus: null,
        };
        state.transfers.set(key, transfer);
        renderTransfer(transfer);
        peer.sendQueue.push(transfer);
        queued += 1;
      }
      processPeerQueue(peer);
    }

    if (queued > 0) {
      toast(
        `${queued} transfer${queued === 1 ? '' : 's'} queued${targets.length > 1 ? ` · ${targets.length} devices` : ''}.`,
        'info',
        3200,
      );
    }
    if (skipped > 0) {
      toast(`${skipped} file${skipped === 1 ? '' : 's'} skipped because the size limit is 100 GB.`, 'error', 5000);
    }
  }

  async function processPeerQueue(peer) {
    if (peer.sending || peer.destroyed) return;
    peer.sending = true;
    try {
      while (peer.sendQueue.length > 0 && !peer.destroyed) {
        const transfer = peer.sendQueue.shift();
        if (!transfer || transfer.cancelled || transfer.status === 'cancelled') continue;
        await sendFileToPeer(peer, transfer);
      }
    } finally {
      peer.sending = false;
    }
  }

  async function sendFileToPeer(peer, transfer) {
    const channel = peer.dc;
    if (!channel || channel.readyState !== 'open') {
      transfer.status = 'error';
      transfer.error = 'Device not connected';
      updateTransferUI(transfer, true);
      return;
    }

    peer.activeSend = transfer;
    transfer.status = 'offered';
    transfer.error = null;
    transfer.startedAt = null;
    updateTransferUI(transfer, true);

    const accepted = await waitForAcceptance(peer, transfer);
    if (transfer.cancelled || transfer.status === 'cancelled') return;
    if (!accepted) {
      if (!['rejected', 'error', 'cancelled'].includes(transfer.status)) {
        transfer.status = 'error';
        transfer.error = transfer.rejectReason || 'File was not accepted';
      }
      // The accept timer has already flipped the status; the card still needs
      // a render or it would stay on "Waiting for acceptance" forever.
      updateTransferUI(transfer, true);
      return;
    }

    if (peer.dc !== channel || channel.readyState !== 'open') {
      transfer.status = 'error';
      transfer.error = 'Data channel lost';
      updateTransferUI(transfer, true);
      return;
    }

    transfer.status = 'sending';
    transfer.startedAt = performance.now();
    transfer.lastSampleAt = transfer.startedAt;
    transfer.lastSampleBytes = 0;
    transfer.bytes = 0;
    transfer.speed = 0;
    updateTransferUI(transfer, true);

    try {
      let offset = 0;
      while (offset < transfer.size) {
        if (transfer.cancelled) throw transferError('cancelled');
        await waitForSendCapacity(peer, transfer);
        if (transfer.cancelled) throw transferError('cancelled');
        if (peer.dc !== channel || channel.readyState !== 'open') {
          throw transferError('channel-closed');
        }

        const end = Math.min(offset + CHUNK_SIZE, transfer.size);
        const chunk = await transfer.file.slice(offset, end).arrayBuffer();
        if (transfer.cancelled) throw transferError('cancelled');
        if (peer.dc !== channel || channel.readyState !== 'open') {
          throw transferError('channel-closed');
        }

        channel.send(chunk);
        offset = end;
        transfer.bytes = offset;
        sampleTransferSpeed(transfer);

        const now = performance.now();
        if (now - transfer.lastUiAt > 90) {
          transfer.lastUiAt = now;
          updateTransferUI(transfer);
        }
      }

      if (transfer.cancelled) throw transferError('cancelled');
      transfer.bytes = transfer.size;
      transfer.status = 'awaiting-ack';
      transfer.speed = 0;
      updateTransferUI(transfer, true);

      const delivery = await waitForDelivery(peer, transfer);
      if (transfer.status === 'cancelled') {
        transfer.error = transfer.error || 'Cancelled';
      } else if (delivery.ok) {
        transfer.status = 'complete';
        transfer.delivered = true;
        transfer.completedAt = Date.now();
      } else if (delivery.timeout) {
        transfer.status = 'complete';
        transfer.unconfirmed = true;
        transfer.completedAt = Date.now();
      } else {
        transfer.status = 'error';
        transfer.error = delivery.reason || 'The other device could not save the file';
      }
      updateTransferUI(transfer, true);
    } catch (error) {
      if (transfer.cancelled || error?.code === 'cancelled') {
        if (!['cancelled', 'error', 'rejected'].includes(transfer.status)) {
          transfer.status = 'cancelled';
          transfer.error = 'Cancelled';
        }
      } else if (transfer.status !== 'rejected' && transfer.status !== 'error') {
        transfer.status = 'error';
        transfer.error = error?.code === 'channel-closed' ? 'Data channel lost' : 'Transfer failed';
        if (error?.code !== 'channel-closed') {
          sendControl(peer, {
            type: 'file-cancel',
            id: transfer.protocolId,
            reason: 'sender-error',
          });
        }
      }
      updateTransferUI(transfer, true);
    } finally {
      if (transfer.acceptTimer) clearTimeout(transfer.acceptTimer);
      if (transfer.ackTimer) clearTimeout(transfer.ackTimer);
      transfer.acceptResolve = null;
      transfer.completeResolve = null;
      if (peer.activeSend === transfer) peer.activeSend = null;
      updateTransferUI(transfer, true);
    }
  }

  function waitForAcceptance(peer, transfer) {
    return new Promise((resolve) => {
      transfer.acceptResolve = (accepted) => {
        if (transfer.acceptTimer) clearTimeout(transfer.acceptTimer);
        transfer.acceptTimer = null;
        transfer.acceptResolve = null;
        resolve(accepted);
      };

      transfer.acceptTimer = window.setTimeout(() => {
        if (!transfer.acceptResolve) return;
        transfer.rejectReason = 'Accept timed out';
        transfer.status = 'error';
        transfer.error = 'The device did not respond within 2 minutes';
        sendControl(peer, { type: 'file-cancel', id: transfer.protocolId, reason: 'accept-timeout' });
        transfer.acceptResolve(false);
      }, ACCEPT_TIMEOUT_MS);

      const sent = sendControl(peer, {
        type: 'file-start',
        id: transfer.protocolId,
        name: transfer.name,
        size: transfer.size,
        mime: transfer.mime,
      });
      if (!sent) {
        transfer.status = 'error';
        transfer.error = 'Data channel closed';
        transfer.acceptResolve(false);
      }
    });
  }

  function waitForDelivery(peer, transfer) {
    return new Promise((resolve) => {
      transfer.completeResolve = (result) => {
        if (transfer.ackTimer) clearTimeout(transfer.ackTimer);
        transfer.ackTimer = null;
        transfer.completeResolve = null;
        resolve(result);
      };

      transfer.ackTimer = window.setTimeout(() => {
        transfer.completeResolve?.({ ok: false, timeout: true });
      }, DELIVERY_TIMEOUT_MS);

      if (!sendControl(peer, { type: 'file-end', id: transfer.protocolId })) {
        transfer.completeResolve?.({ ok: false, reason: 'Data channel closed' });
      }
    });
  }

  async function waitForSendCapacity(peer, transfer) {
    const channel = peer.dc;
    if (!channel || channel.readyState !== 'open') throw transferError('channel-closed');
    if (channel.bufferedAmount <= BUFFER_HIGH_WATER) return;

    const started = performance.now();
    while (channel.bufferedAmount > BUFFER_LOW_WATER) {
      if (transfer.cancelled) throw transferError('cancelled');
      if (peer.dc !== channel || channel.readyState !== 'open') throw transferError('channel-closed');
      if (performance.now() - started > 60_000) throw transferError('buffer-timeout');
      await sleep(40);
    }
  }

  function transferError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function handleFileAccept(peer, protocolId) {
    if (!isSafeId(protocolId)) return;
    const transfer = findOutgoingTransfer(peer.id, protocolId);
    if (!transfer || transfer.status !== 'offered') return;
    transfer.acceptResolve?.(true);
  }

  function handleFileReject(peer, protocolId, reason) {
    if (!isSafeId(protocolId)) return;
    const transfer = findOutgoingTransfer(peer.id, protocolId);
    if (!transfer) return;
    transfer.rejectReason = String(reason || 'File declined').slice(0, 160);
    transfer.status = 'rejected';
    transfer.error = transfer.rejectReason;
    updateTransferUI(transfer, true);
    transfer.acceptResolve?.(false);
  }

  function handleFileComplete(peer, protocolId) {
    if (!isSafeId(protocolId)) return;
    const transfer = findOutgoingTransfer(peer.id, protocolId);
    if (!transfer) return;
    transfer.delivered = true;
    transfer.completeResolve?.({ ok: true });
  }

  function handleFileError(peer, protocolId, reason) {
    if (!isSafeId(protocolId)) return;
    const transfer = findOutgoingTransfer(peer.id, protocolId);
    if (!transfer) return;
    if (transfer.status === 'awaiting-ack') {
      transfer.completeResolve?.({ ok: false, reason: String(reason || 'The other device could not save it') });
    } else {
      transfer.cancelled = true;
      transfer.status = 'error';
      transfer.error = 'The other device could not save the file';
      transfer.acceptResolve?.(false);
      updateTransferUI(transfer, true);
    }
  }

  function handleFileCancel(peer, protocolId, reason) {
    if (!isSafeId(protocolId)) return;
    const outgoing = findOutgoingTransfer(peer.id, protocolId);
    if (outgoing) {
      outgoing.cancelled = true;
      if (!['complete', 'error'].includes(outgoing.status)) {
        outgoing.status = 'cancelled';
        outgoing.error = String(reason === 'receive-error' ? 'Error on the receiver' : 'The other device cancelled');
      }
      outgoing.acceptResolve?.(false);
      outgoing.completeResolve?.({ ok: false, reason: outgoing.error });
      updateTransferUI(outgoing, true);
    }

    const incoming = peer.incoming;
    if (incoming && incoming.protocolId === protocolId) {
      peer.incoming = null;
      incoming.cancelled = true;
      incoming.status = 'cancelled';
      incoming.error = 'The sender cancelled';
      updateTransferUI(incoming, true);
      abortIncoming(incoming);
    }
  }

  function findOutgoingTransfer(peerId, protocolId) {
    for (const transfer of state.transfers.values()) {
      if (transfer.direction === 'out' && transfer.peerId === peerId && transfer.protocolId === protocolId) {
        return transfer;
      }
    }
    return null;
  }

  function cancelPeerTransfers(peer, reason) {
    peer.sendQueue = [];
    const message = reason || 'Connection closed';
    for (const transfer of state.transfers.values()) {
      if (transfer.peerId !== peer.id) continue;
      if (['complete', 'error', 'cancelled', 'rejected'].includes(transfer.status)) continue;

      transfer.cancelled = true;
      if (transfer.direction === 'out') {
        transfer.status = 'error';
        transfer.error = message;
        transfer.acceptResolve?.(false);
        transfer.completeResolve?.({ ok: false, reason: message });
      } else {
        transfer.status = 'error';
        transfer.error = message;
        abortIncoming(transfer);
      }
      updateTransferUI(transfer, true);
    }
    if (peer.incoming) {
      peer.incoming = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transfer UI
  // ---------------------------------------------------------------------------

  function renderTransfer(transfer) {
    const article = els.transferTemplate.content.firstElementChild.cloneNode(true);
    article.dataset.key = transfer.key;
    article.dataset.status = transfer.status;
    article.dataset.direction = transfer.direction;

    const name = article.querySelector('.transfer__name');
    name.textContent = transfer.name;
    name.title = transfer.name;

    const peer = article.querySelector('.transfer__peer');
    peer.textContent = transfer.direction === 'out' ? `→ ${transfer.peerName}` : `← ${transfer.peerName}`;
    peer.title = transfer.peerName;

    els.transferList.appendChild(article);
    transfer.el = article;
    updateTransferCount();
    updateTransferUI(transfer, true);
    pruneTransferRows();
  }

  function pruneTransferRows() {
    if (state.transfers.size <= MAX_TRANSFER_ROWS) return;
    for (const transfer of [...state.transfers.values()]) {
      if (state.transfers.size <= MAX_TRANSFER_ROWS) break;
      // Never drop an active transfer: its row still hosts cancel/accept
      // controls and the transfer keeps a reference to it. Only finished rows
      // are safe to reclaim.
      if (!['complete', 'error', 'cancelled', 'rejected'].includes(transfer.status)) continue;
      removeTransfer(transfer);
    }
  }

  function updateTransferUI(transfer, forceActions = false) {
    if (!transfer.el) return;
    const el = transfer.el;
    const percent = Math.max(
      0,
      Math.min(100, transfer.status === 'complete' ? 100 : transfer.size === 0 ? 100 : (transfer.bytes / transfer.size) * 100),
    );
    const rounded = Math.floor(percent);

    el.dataset.status = transfer.status;
    el.querySelector('.transfer__percent').textContent = `${rounded}%`;
    el.querySelector('.transfer__size').textContent =
      `${formatBytes(transfer.bytes)} / ${formatBytes(transfer.size)}`;

    const speedEl = el.querySelector('.transfer__speed');
    if (['sending', 'receiving'].includes(transfer.status) && transfer.speed > 0) {
      speedEl.textContent = formatSpeed(transfer.speed);
    } else if (transfer.status === 'complete') {
      speedEl.textContent = 'done';
    } else {
      speedEl.textContent = '—';
    }

    const progress = el.querySelector('.progress-track');
    progress.setAttribute('aria-valuenow', String(rounded));
    progress.setAttribute('aria-label', `${transfer.name} transfer progress`);
    el.querySelector('.progress-fill').style.width = `${percent}%`;

    const statusEl = el.querySelector('.transfer__status');
    const label = transferStatusLabel(transfer);
    statusEl.textContent = label;
    statusEl.title = label;

    if (forceActions || transfer.lastRenderedStatus !== transfer.status) {
      transfer.lastRenderedStatus = transfer.status;
      renderTransferActions(transfer);
    }
  }

  function transferStatusLabel(transfer) {
    switch (transfer.status) {
      case 'queued':
        return 'Queued';
      case 'offered':
        return 'Waiting for acceptance';
      case 'sending':
        return 'Sending';
      case 'awaiting-ack':
        return 'The other device is saving';
      case 'incoming':
        return 'Incoming file · accept';
      case 'preparing':
        return 'Choosing save location';
      case 'receiving':
        return 'Receiving';
      case 'processing':
        return 'Processing file';
      case 'complete':
        if (transfer.direction === 'out') {
          if (transfer.unconfirmed) return 'Sent · unconfirmed';
          return transfer.delivered ? 'Delivered' : 'Sent';
        }
        return transfer.storage === 'disk' ? 'Saved' : 'Ready to download';
      case 'rejected':
        return transfer.error || 'Declined';
      case 'cancelled':
        return transfer.error || 'Cancelled';
      case 'error':
        return transfer.error || 'Failed';
      default:
        return transfer.status;
    }
  }

  function renderTransferActions(transfer) {
    if (!transfer.el) return;
    const container = transfer.el.querySelector('.transfer__actions');
    container.replaceChildren();

    if (transfer.direction === 'in') {
      if (transfer.status === 'incoming') {
        container.append(
          actionButton('Accept', 'accept', 'primary'),
          actionButton('Decline', 'reject', 'danger'),
        );
      } else if (transfer.status === 'receiving') {
        container.append(actionButton('Cancel', 'cancel', 'danger'));
      } else if (transfer.status === 'complete' && transfer.downloadUrl) {
        const link = document.createElement('a');
        link.className = 'btn btn--small btn--primary';
        link.href = transfer.downloadUrl;
        link.download = transfer.fileName || transfer.name;
        link.textContent = 'Download';
        container.appendChild(link);
      }
    } else if (['queued', 'offered', 'sending', 'awaiting-ack'].includes(transfer.status)) {
      container.append(actionButton('Cancel', 'cancel', 'danger'));
    }

    if (['complete', 'error', 'rejected', 'cancelled'].includes(transfer.status)) {
      container.append(actionButton('Remove', 'remove', 'ghost'));
    }
  }

  function actionButton(label, action, variant) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn--small btn--${variant || 'ghost'}`;
    button.textContent = label;
    button.dataset.transferAction = action;
    return button;
  }

  function updateTransferCount() {
    const count = state.transfers.size;
    els.transferCount.textContent = `${count} transfer${count === 1 ? '' : 's'}`;
    els.transferEmpty.hidden = count > 0;
  }

  function removeTransfer(transfer) {
    if (!transfer || !['complete', 'error', 'rejected', 'cancelled'].includes(transfer.status)) return;
    if (transfer.downloadUrl) {
      try {
        URL.revokeObjectURL(transfer.downloadUrl);
      } catch (error) {
        /* noop */
      }
    }
    transfer.el?.remove();
    state.transfers.delete(transfer.key);
    updateTransferCount();
  }

  function clearFinishedTransfers() {
    for (const [key, transfer] of [...state.transfers]) {
      if (!['complete', 'error', 'rejected', 'cancelled'].includes(transfer.status)) continue;
      if (transfer.downloadUrl) {
        try {
          URL.revokeObjectURL(transfer.downloadUrl);
        } catch (error) {
          /* noop */
        }
      }
      transfer.el?.remove();
      state.transfers.delete(key);
    }
    updateTransferCount();
  }

  function cancelTransfer(transfer) {
    if (!transfer) return;
    const peer = state.peers.get(transfer.peerId);

    if (transfer.direction === 'out') {
      if (transfer.status === 'queued') {
        transfer.cancelled = true;
        transfer.status = 'cancelled';
        transfer.error = 'Cancelled';
        if (peer) {
          peer.sendQueue = peer.sendQueue.filter((item) => item !== transfer);
        }
        updateTransferUI(transfer, true);
        return;
      }

      if (['offered', 'sending', 'awaiting-ack'].includes(transfer.status)) {
        transfer.cancelled = true;
        transfer.status = 'cancelled';
        transfer.error = 'Cancelled';
        transfer.acceptResolve?.(false);
        transfer.completeResolve?.({ ok: false, reason: 'Cancelled' });
        if (peer) {
          sendControl(peer, {
            type: 'file-cancel',
            id: transfer.protocolId,
            reason: 'sender-cancelled',
          });
        }
        updateTransferUI(transfer, true);
      }
      return;
    }

    if (transfer.status === 'incoming') {
      rejectIncoming(transfer, 'User declined');
      return;
    }

    if (transfer.status === 'receiving') {
      transfer.cancelled = true;
      transfer.status = 'cancelled';
      transfer.error = 'Cancelled';
      if (peer) {
        if (peer.incoming === transfer) peer.incoming = null;
        sendControl(peer, {
          type: 'file-cancel',
          id: transfer.protocolId,
          reason: 'receiver-cancelled',
        });
      }
      updateTransferUI(transfer, true);
      abortIncoming(transfer);
    }
  }

  function sampleTransferSpeed(transfer) {
    const now = performance.now();
    if (!transfer.startedAt) transfer.startedAt = now;
    if (!transfer.lastSampleAt) {
      transfer.lastSampleAt = now;
      transfer.lastSampleBytes = transfer.bytes;
      return;
    }
    const elapsed = (now - transfer.lastSampleAt) / 1000;
    if (elapsed < 0.35) return;
    const instant = (transfer.bytes - transfer.lastSampleBytes) / elapsed;
    transfer.speed = transfer.speed > 0 ? transfer.speed * 0.65 + instant * 0.35 : instant;
    transfer.lastSampleAt = now;
    transfer.lastSampleBytes = transfer.bytes;
  }

  // ---------------------------------------------------------------------------
  // Text messages
  // ---------------------------------------------------------------------------

  function sendText() {
    const text = els.textInput.value.replace(/\r\n/g, '\n').trim();
    if (!text) return;
    if (text.length > MAX_TEXT_LENGTH) {
      toast(`Text can be at most ${MAX_TEXT_LENGTH.toLocaleString('en-US')} characters.`, 'error');
      return;
    }

    const targets = selectedConnectedPeers();
    if (targets.length === 0) {
      toast('Select a connected device to send text.', 'error');
      return;
    }

    const at = Date.now();
    const id = createId();
    let sent = 0;
    for (const peer of targets) {
      if (
        sendControl(peer, {
          type: 'text',
          id,
          text,
          at,
        })
      ) {
        sent += 1;
      }
    }

    if (sent === 0) {
      toast('Could not send the text. Check the connection.', 'error');
      return;
    }

    addMessage({ sender: state.selfName, text, at, outgoing: true });
    els.textInput.value = '';
    updateTextComposer();
    els.textInput.focus();
  }

  function addMessage({ sender, text, at, outgoing }) {
    if (typeof text !== 'string' || !text.trim()) return;
    const node = els.messageTemplate.content.firstElementChild.cloneNode(true);
    const senderEl = node.querySelector('.message__sender');
    const timeEl = node.querySelector('.message__time');
    const textEl = node.querySelector('.message__text');

    senderEl.textContent = outgoing ? 'YOU' : cleanName(sender, 32) || 'Device';
    senderEl.title = senderEl.textContent;
    const timestamp = Number(at);
    let date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
    if (Number.isNaN(date.getTime())) date = new Date();
    timeEl.dateTime = date.toISOString();
    timeEl.textContent = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    textEl.textContent = text;
    if (outgoing) node.classList.add('message--outgoing');

    els.messageList.appendChild(node);
    state.messages.push(node);
    while (state.messages.length > MAX_MESSAGES) {
      state.messages.shift()?.remove();
    }
    els.messageEmpty.hidden = true;
    els.messageList.scrollTop = els.messageList.scrollHeight;
  }

  function clearMessages() {
    els.messageList.replaceChildren();
    state.messages = [];
    els.messageEmpty.hidden = false;
  }

  function updateTextComposer() {
    const length = els.textInput.value.length;
    els.textCounter.textContent = `${length.toLocaleString('en-US')} / ${MAX_TEXT_LENGTH.toLocaleString('en-US')}`;
    updateSendAvailability();
  }

  function updateSendAvailability() {
    const hasText = els.textInput.value.trim().length > 0;
    const hasTargets = selectedConnectedPeers().length > 0;
    els.btnSendText.disabled = !hasText || !hasTargets;
    els.btnSendText.title = !hasTargets ? 'Select a connected device first' : '';
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle + QR
  // ---------------------------------------------------------------------------

  function leaveRoom() {
    if (!state.room) return;
    if (state.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'leave' });
    }

    state.leaving = true;
    state.pendingRoomAction = null;
    clearTimeout(state.joinTimer);
    state.joinTimer = null;

    closeAllPeers('You left the room');
    clearRoomLists();

    state.room = null;
    state.pendingAutoJoin = null;
    state.selfName = '';
    state.rejoinBlocked = false;
    clearSessionRoom();
    state.reconnectAttempts = 0;
    updateRoomUrl(null);
    hideOfflineBanner();
    setJoinBusy(false);
    showLandingView();
    toast('You left the room.');
    els.roomInput.focus({ preventScroll: true });

    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
      connectSignaling();
    }
    window.setTimeout(() => {
      state.leaving = false;
    }, 250);
  }

  function clearRoomLists() {
    for (const transfer of state.transfers.values()) {
      if (transfer.downloadUrl) {
        try {
          URL.revokeObjectURL(transfer.downloadUrl);
        } catch (error) {
          /* noop */
        }
      }
    }
    state.transfers.clear();
    state.selectedPeers.clear();
    state.messages = [];

    els.transferList.replaceChildren();
    els.messageList.replaceChildren();
    els.peerList.replaceChildren();
    els.transferEmpty.hidden = false;
    els.messageEmpty.hidden = false;
    els.roomCodeDisplay.textContent = '------';
    els.textInput.value = '';
    els.targetSummary.classList.add('is-idle');
    els.targetText.textContent = 'Looking for a device…';
    els.peerCount.textContent = 'just you';
    els.meshLabel.textContent = 'Waiting for signal';
    updateTextComposer();
    updateTransferCount();
  }

  function openQrDialog() {
    if (!state.room) return;
    const url = roomUrl();
    els.qrLinkText.textContent = url;
    els.qrLinkText.title = url;

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Preparing QR…';
    els.qrLoading.replaceChildren(spinner, label);
    els.qrLoading.hidden = false;
    els.qrImage.removeAttribute('src');

    const api = `/api/qr?text=${encodeURIComponent(url)}`;
    els.qrDownload.href = `${api}&download=1&v=${Date.now()}`;

    els.qrImage.onload = () => {
      els.qrLoading.hidden = true;
    };
    els.qrImage.onerror = () => {
      els.qrLoading.replaceChildren();
      const errorLabel = document.createElement('span');
      errorLabel.textContent = 'Could not create the QR code. You can copy the link instead.';
      els.qrLoading.appendChild(errorLabel);
    };
    els.qrImage.src = `${api}&v=${Date.now()}`;

    if (typeof els.qrDialog.showModal === 'function') {
      if (!els.qrDialog.open) els.qrDialog.showModal();
    } else {
      els.qrDialog.setAttribute('open', '');
    }
    document.body.classList.add('modal-open');
  }

  function closeQrDialog() {
    if (typeof els.qrDialog.close === 'function' && els.qrDialog.open) {
      els.qrDialog.close();
    } else {
      els.qrDialog.removeAttribute('open');
    }
    document.body.classList.remove('modal-open');
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  async function copyText(text, successMessage) {
    if (!text) return;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (error) {
        copied = false;
      }
    }

    if (!copied) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        textarea.remove();
      } catch (error) {
        copied = false;
      }
    }

    if (copied) toast(successMessage || 'Copied.', 'success');
    else toast('Could not copy. Select the link manually.', 'error');
  }

  function toast(message, type = 'info', duration = 3800) {
    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    node.textContent = message;

    const existing = els.toastRegion.querySelectorAll('.toast');
    if (existing.length >= 4) existing[0].remove();
    els.toastRegion.appendChild(node);

    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 280);
    }, duration);
  }

  function showLandingError(message) {
    els.landingError.textContent = message;
    els.landingError.hidden = false;
  }

  function hideLandingError() {
    els.landingError.hidden = true;
    els.landingError.textContent = '';
  }

  function showOfflineBanner(message) {
    if (message) els.offlineMessage.textContent = message;
    els.offlineBanner.hidden = false;
  }

  function hideOfflineBanner() {
    els.offlineBanner.hidden = true;
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
        const valid = config.iceServers.filter(
          (server) => server && typeof server === 'object' && server.urls,
        );
        if (valid.length > 0) state.config.iceServers = valid;
      }
      if (typeof config.version === 'string' && config.version.length < 24) {
        state.config.version = config.version;
      }
      if (Number.isInteger(config.maxPeers)) state.maxPeers = config.maxPeers;
      if (config.iceTransportPolicy === 'relay') {
        state.config.iceTransportPolicy = 'relay';
      } else {
        state.config.iceTransportPolicy = 'all';
      }
      state.config.turnMode = typeof config.turnMode === 'string' ? config.turnMode : 'none';
      state.config.iceTtl = Number.isInteger(config.iceTtl) && config.iceTtl > 0 ? config.iceTtl : 0;
      state.config.iceExpiresAt = state.config.iceTtl ? Date.now() + state.config.iceTtl * 1000 : 0;
      updateVersionLabels();
    } catch (error) {
      console.warn('[config] using default ICE servers', error);
    }
    updateNetworkChip();
    return state.config;
  }

  function updateNetworkChip() {
    if (!els.netChip) return;
    const hasTurn = protocol.hasTurnServer(state.config.iceServers);
    if (hasTurn) {
      els.netChip.dataset.mode = 'turn';
      els.netChip.textContent =
        state.config.turnMode === 'dynamic' ? 'TURN · short-lived' : 'TURN ready';
      els.netChip.title =
        'TURN configured: devices on different networks can connect too. Traffic is end-to-end DTLS encrypted.';
    } else {
      els.netChip.dataset.mode = 'stun';
      els.netChip.textContent = 'STUN';
      els.netChip.title =
        'STUN only: enough for most home networks. On strict NAT or corporate networks, configure TURN on the server.';
    }
  }

  function updateVersionLabels() {
    const label = `v${state.config.version}`;
    els.versionChip.textContent = label;
    els.footerVersion.textContent = label;
  }

  function setDefaultName() {
    let name = readStoredName();
    if (!name) {
      name = suggestDeviceName();
      storeName(name);
    }
    state.selfName = name;
    els.deviceName.value = name;
  }

  function suggestDeviceName() {
    let device = 'iShare';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/win/i.test(platform)) device = 'Windows';
    else if (/android/i.test(platform)) device = 'Android';
    else if (/iphone|ipad|ipod/i.test(platform)) device = 'iOS';
    else if (/mac/i.test(platform)) device = 'Mac';
    else if (/linux/i.test(platform)) device = 'Linux';

    const animals = ['Lynx', 'Falcon', 'Fox', 'Panther', 'Eagle', 'Dolphin', 'Owl', 'Cheetah'];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${device} ${animal}`.slice(0, 32);
  }

  function readStoredName() {
    try {
      return cleanName(window.localStorage.getItem('ishare:name') || '', 32);
    } catch (error) {
      return '';
    }
  }

  function storeName(name) {
    try {
      window.localStorage.setItem('ishare:name', name);
    } catch (error) {
      /* private mode */
    }
  }

  // sessionStorage is per tab and survives a reload, which lets a refreshed tab
  // keep its signaling identity (resume) without leaking it to other tabs.
  function loadClientId() {
    try {
      const stored = window.sessionStorage.getItem(SESSION_ID_KEY);
      if (isSafeId(stored)) return stored;
    } catch (error) {
      /* private mode */
    }
    const id = createId();
    storeClientId(id);
    return id;
  }

  function storeClientId(id) {
    try {
      window.sessionStorage.setItem(SESSION_ID_KEY, id);
    } catch (error) {
      /* private mode */
    }
  }

  function readSessionRoom() {
    try {
      const room = window.sessionStorage.getItem(SESSION_ROOM_KEY);
      return room && room.length === ROOM_CODE_LENGTH ? room : null;
    } catch (error) {
      return null;
    }
  }

  function storeSessionRoom(room) {
    try {
      window.sessionStorage.setItem(SESSION_ROOM_KEY, room);
    } catch (error) {
      /* private mode */
    }
  }

  function clearSessionRoom() {
    try {
      window.sessionStorage.removeItem(SESSION_ROOM_KEY);
    } catch (error) {
      /* private mode */
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function createId() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch (error) {
      /* fall through */
    }
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return `c-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function isSafeId(value) {
    return protocol.isSafeId(value);
  }

  function normalizeRoomCodeInput(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, ROOM_CODE_LENGTH);
  }

  function cleanName(value, maxLength) {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function sanitizeFileName(value) {
    return protocol.sanitizeFileName(value);
  }

  function sanitizeMime(value) {
    return protocol.sanitizeMime(value);
  }

  function initialOf(name) {
    const chars = Array.from(String(name || '').trim());
    return (chars[0] || '?').toLocaleUpperCase();
  }

  function hashTone(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash % 5;
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const amount = bytes / 1024 ** index;
    const decimals = index === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(decimals)} ${units[index]}`;
  }

  function formatSpeed(bytesPerSecond) {
    return `${formatBytes(bytesPerSecond)}/s`;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  init();
})();
