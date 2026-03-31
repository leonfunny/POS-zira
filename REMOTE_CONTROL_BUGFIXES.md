# Remote Control - Bug Fixes Guide

Hướng dẫn sửa lỗi cho tính năng Remote Control trước khi deploy.

---

## 1. Print Agent (Electron)

### File: `src/main/remote/remote-session-manager.ts`

#### Fix 1.1: Xóa duplicate event emission (line ~296-322)

**Trước:**
```typescript
endSession(reason: string = 'Session ended'): void {
  // ...
  // Emit both events for compatibility
  this.emit('sessionEnd', { sessionId: session.sessionId, reason });
  this.emit('sessionEnded', session);
  // ...
}
```

**Sau:**
```typescript
endSession(reason: string = 'Session ended'): void {
  if (!this.currentSession) {
    return;
  }

  console.log('[RemoteSession] Ending session:', reason);

  const session = this.currentSession;
  session.status = RemoteSessionStatus.DISCONNECTED;
  session.endedAt = new Date();

  // Stop all components
  this.inputExecutor.setEnabled(false);
  this.webrtcPeer.close();
  this.screenCapturer.stopCapture();

  // Clear timeouts
  this.clearSessionTimeout();
  this.clearRequestTimeout();

  // Emit session ended (single event with full session data)
  this.emit('sessionEnded', session);

  this.currentSession = null;
  this.pendingRequest = null;
  this.emitStateChanged();
}
```

#### Fix 1.2: Fix unsafe null casting in dialog (line ~430-454)

**Trước:**
```typescript
async showSessionRequestDialog(
  request: RemoteSessionRequest,
  parentWindow?: BrowserWindow
): Promise<boolean> {
  const message = `${request.userName || 'Someone'} wants to remotely control this computer.\n\nDo you want to allow this?`;

  const result = await dialog.showMessageBox(
    parentWindow || BrowserWindow.getFocusedWindow() as BrowserWindow,
    {
      type: 'question',
      // ...
    }
  );

  return result.response === 0;
}
```

**Sau:**
```typescript
async showSessionRequestDialog(
  request: RemoteSessionRequest,
  parentWindow?: BrowserWindow
): Promise<boolean> {
  const message = `${request.userName || 'Someone'} wants to remotely control this computer.\n\nDo you want to allow this?`;

  // Get window - use parentWindow, focused window, or show without parent
  const targetWindow = parentWindow || BrowserWindow.getFocusedWindow();

  const dialogOptions = {
    type: 'question' as const,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    title: 'Remote Control Request',
    message: 'Remote Control Request',
    detail: message,
  };

  const result = targetWindow
    ? await dialog.showMessageBox(targetWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);

  return result.response === 0;
}
```

---

### File: `src/main/app.ts`

#### Fix 1.3: Thêm try-catch và sửa event handler

Tìm phần setup remote session events và sửa:

**Trước:**
```typescript
// Remote session events
this.remoteSessionManager.on('sessionResponse', (response) => {
  this.socket?.sendRemoteSessionResponse(response);
});

this.remoteSessionManager.on('iceCandidate', (candidate) => {
  if (this.remoteSessionManager.hasActiveSession()) {
    const session = this.remoteSessionManager.getState().session;
    if (session) {
      this.socket?.sendRemoteIceCandidate(session.sessionId, candidate);
    }
  }
});

this.remoteSessionManager.on('sessionEnd', ({ sessionId }) => {
  this.socket?.sendRemoteSessionEnd(sessionId);
});

this.remoteSessionManager.on('sessionEnded', (session) => {
  logger.info(`[Remote] Session ended: ${session.sessionId}`);
});
```

**Sau:**
```typescript
// Remote session events
this.remoteSessionManager.on('sessionResponse', (response) => {
  try {
    this.socket?.sendRemoteSessionResponse(response);
  } catch (error) {
    logger.error('[Remote] Error sending session response:', error);
  }
});

this.remoteSessionManager.on('iceCandidate', (candidate) => {
  try {
    if (this.remoteSessionManager.hasActiveSession()) {
      const session = this.remoteSessionManager.getState().session;
      if (session) {
        this.socket?.sendRemoteIceCandidate(session.sessionId, candidate);
      }
    }
  } catch (error) {
    logger.error('[Remote] Error sending ICE candidate:', error);
  }
});

// Only listen to sessionEnded (sessionEnd was removed)
this.remoteSessionManager.on('sessionEnded', (session) => {
  logger.info(`[Remote] Session ended: ${session.sessionId}`);
  try {
    this.socket?.sendRemoteSessionEnd(session.sessionId);
  } catch (error) {
    logger.error('[Remote] Error sending session end:', error);
  }
});
```

---

## 2. Backend (NestJS)

### File: `backend/src/modules/print-agent/remote/remote.service.ts`

#### Fix 2.1: Thêm method public để lấy dashboard socket

Thêm method mới vào class `RemoteService` (sau method `getSessionByDashboardSocket`):

```typescript
/**
 * Get dashboard socket ID by session ID
 */
getDashboardSocketBySessionId(sessionId: string): string | undefined {
  for (const [socketId, sid] of this.dashboardSessions.entries()) {
    if (sid === sessionId) {
      return socketId;
    }
  }
  return undefined;
}
```

---

### File: `backend/src/modules/print-agent/remote/remote.gateway.ts`

#### Fix 2.2: Sửa method findDashboardSocket

**Trước:**
```typescript
/**
 * Find dashboard socket ID for a session
 */
private findDashboardSocket(sessionId: string): string | undefined {
  // This was incorrectly trying to access private map
  for (const [socketId, sid] of this.connectedDashboards) {
    if (sid === sessionId) {
      return socketId;
    }
  }
  return undefined;
}
```

**Sau:**
```typescript
/**
 * Find dashboard socket ID for a session
 */
private findDashboardSocket(sessionId: string): string | undefined {
  return this.remoteService.getDashboardSocketBySessionId(sessionId);
}
```

---

## 3. Dashboard (Next.js)

### File: `frontend/src/hooks/useWebRTC.ts`

#### Fix 3.1: Thêm disconnectRef

Thêm ref mới trong phần Refs (sau line 71):

```typescript
// Refs
const videoRef = useRef<HTMLVideoElement>(null);
const socketRef = useRef<Socket | null>(null);
const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
const dataChannelRef = useRef<RTCDataChannel | null>(null);
const sessionIdRef = useRef<string | null>(null);
const qualityRef = useRef<RemoteQuality>(quality);
const disconnectRef = useRef<(() => void) | null>(null);  // <-- THÊM DÒNG NÀY
```

#### Fix 3.2: Sửa session response callback

Tìm trong function `connect`, sửa callback:

**Trước:**
```typescript
socket.emit('remote:request-session', {
  agentId,
  quality: qualityRef.current,
}, (response: any) => {
  if (response.error) {
    handleError(new Error(response.error));
  } else {
    console.log('[WebRTC] Session requested:', response.sessionId);
    sessionIdRef.current = response.sessionId;
  }
});
```

**Sau:**
```typescript
socket.emit('remote:request-session', {
  agentId,
  quality: qualityRef.current,
}, (response: any) => {
  if (!response.success) {
    handleError(new Error(response.message || response.error || 'Failed to request session'));
  } else {
    console.log('[WebRTC] Session requested:', response.sessionId);
    sessionIdRef.current = response.sessionId;
  }
});
```

#### Fix 3.3: Sửa handleSessionEnd để dùng ref

**Trước:**
```typescript
// Handle session end
const handleSessionEnd = useCallback((data: { sessionId: string; reason?: string }) => {
  console.log('[WebRTC] Session ended:', data.reason);
  disconnect();
}, [disconnect]);
```

**Sau:**
```typescript
// Handle session end
const handleSessionEnd = useCallback((data: { sessionId: string; reason?: string }) => {
  console.log('[WebRTC] Session ended:', data.reason);
  // Use disconnectRef to avoid circular dependency
  disconnectRef.current?.();
}, []);
```

#### Fix 3.4: Thêm useEffect để sync disconnectRef

Thêm useEffect mới trước cleanup useEffect:

```typescript
// Update disconnectRef when disconnect changes
useEffect(() => {
  disconnectRef.current = disconnect;
}, [disconnect]);

// Cleanup on unmount
useEffect(() => {
  return () => {
    disconnect();
    socketRef.current?.disconnect();
  };
}, [disconnect]);
```

---

## 4. Checklist Deploy

### Print Agent
- [ ] Sửa `src/main/remote/remote-session-manager.ts` (Fix 1.1, 1.2)
- [ ] Sửa `src/main/app.ts` (Fix 1.3)
- [ ] Build: `npm run build`
- [ ] Test local trước khi release

### Backend
- [ ] Sửa `remote.service.ts` (Fix 2.1)
- [ ] Sửa `remote.gateway.ts` (Fix 2.2)
- [ ] Build: `npm run build`
- [ ] Deploy lên server

### Dashboard
- [ ] Sửa `frontend/src/hooks/useWebRTC.ts` (Fix 3.1, 3.2, 3.3, 3.4)
- [ ] Build: `npm run build`
- [ ] Deploy lên server

---

## 5. Test sau khi deploy

1. Mở Dashboard, vào trang Remote Control của 1 agent
2. Agent hiện popup xác nhận -> Click Allow
3. Verify video stream hiển thị trên Dashboard
4. Test mouse move, click
5. Test keyboard input
6. Test disconnect từ Dashboard
7. Test disconnect từ Agent
8. Test timeout (đợi 30 phút hoặc giảm timeout để test)

---

## 6. Lưu ý

- Backend cần restart sau khi deploy
- Print Agent cần update version mới cho users
- Nếu dùng TURN server, config trong `.env`:
  ```
  TURN_SERVER_URL=turn:your-turn-server:3478
  TURN_USERNAME=username
  TURN_CREDENTIAL=password
  ```
