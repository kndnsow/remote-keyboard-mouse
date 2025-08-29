document.addEventListener("DOMContentLoaded", () => {
  const state = {
    isConnected: false,
    isAirMouseOn: false,
    stickyKeys: new Set(),
    gesture: {},
    longPressTimeout: null,
    wakeLock: null,
  };

  const airMouseToggle = document.getElementById("air-mouse-toggle");
  const touchpadArea = document.getElementById("touchpad-area");
  const liveKeyboardInput = document.getElementById("live-keyboard-input");

  const GESTURE_CONFIG = {
    EDGE_WIDTH: 50,
    SWIPE_THRESHOLD: 60,
    PINCH_THRESHOLD: 0.1,
    HOLD_DURATION: 400,
  };

  async function sendRequest(endpoint, body) {
    if (!state.isConnected) return;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const statusText = document.getElementById("status-text");
      if (!res.ok && res.status === 429) {
        statusText.textContent = data.message;
      } else if (statusText.textContent.startsWith("Cooldown")) {
        updateStatus(true, "Connected");
      }
    } catch (err) {
      updateStatus(false, "Connection Lost");
    }
  }

  function updateStatus(isConnected, message = "") {
    state.isConnected = isConnected;
    document.getElementById("status-indicator").className = isConnected
      ? "connected"
      : "disconnected";
    document.getElementById("status-text").textContent =
      message || (isConnected ? "Connected" : "Disconnected");
  }

  airMouseToggle.addEventListener("click", () => {
    state.isAirMouseOn = !state.isAirMouseOn;
    airMouseToggle.classList.toggle("active", state.isAirMouseOn);
    airMouseToggle.textContent = state.isAirMouseOn ? "Air On" : "Air Off";
    sendRequest("/api/airmouse", { active: state.isAirMouseOn });
  });

  function handleOrientation(event) {
    if (!state.isAirMouseOn || !event.alpha) return;
    sendRequest("/api/airmouse", {
      active: true,
      orientation: { alpha: event.alpha, beta: event.beta },
    });
  }

  function getTouchDistance(touches) {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );
  }

  touchpadArea.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const touches = e.touches;
      state.gesture = {
        fingers: touches.length,
        startX: touches[0].clientX,
        startY: touches[0].clientY,
        lastX: touches[0].clientX,
        lastY: touches[0].clientY,
        startTime: Date.now(),
        actioned: false,
        holdTimeout: null,
      };
      if (touches.length === 1) {
        state.gesture.holdTimeout = setTimeout(() => {
          sendRequest("/api/touchpad", { action: "right_click" });
          state.gesture.actioned = true;
        }, GESTURE_CONFIG.HOLD_DURATION);
      } else if (touches.length === 2) {
        state.gesture.startDist = getTouchDistance(touches);
        state.gesture.lastY = (touches[0].clientY + touches[1].clientY) / 2;
      }
    },
    { passive: false }
  );

  touchpadArea.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      clearTimeout(state.gesture.holdTimeout);
      const touches = e.touches;
      if (touches.length !== state.gesture.fingers) return;
      if (touches.length === 1) {
        sendRequest("/api/touchpad", {
          action: "move",
          dx: touches[0].clientX - state.gesture.lastX,
          dy: touches[0].clientY - state.gesture.lastY,
        });
        state.gesture.lastX = touches[0].clientX;
        state.gesture.lastY = touches[0].clientY;
      } else if (touches.length === 2) {
        const currentY = (touches[0].clientY + touches[1].clientY) / 2;
        sendRequest("/api/touchpad", {
          action: "scroll",
          dy: currentY - state.gesture.lastY,
        });
        state.gesture.lastY = currentY;
        const currentDist = getTouchDistance(touches);
        const distRatio = currentDist / state.gesture.startDist;
        if (distRatio > 1 + GESTURE_CONFIG.PINCH_THRESHOLD) {
          sendRequest("/api/hotkey", { keys: ["ctrl", "+"] });
          state.gesture.startDist = currentDist;
          state.gesture.actioned = true;
        } else if (distRatio < 1 - GESTURE_CONFIG.PINCH_THRESHOLD) {
          sendRequest("/api/hotkey", { keys: ["ctrl", "-"] });
          state.gesture.startDist = currentDist;
          state.gesture.actioned = true;
        }
      }
    },
    { passive: false }
  );

  touchpadArea.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      clearTimeout(state.gesture.holdTimeout);
      if (state.gesture.actioned) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - state.gesture.startX,
        dy = touch.clientY - state.gesture.startY;
      const fingers = state.gesture.fingers;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20 && fingers === 1) {
        sendRequest("/api/touchpad", { action: "left_click" });
        return;
      }
      const isSwipeUp = dy < -GESTURE_CONFIG.SWIPE_THRESHOLD,
        isSwipeDown = dy > GESTURE_CONFIG.SWIPE_THRESHOLD;
      const isSwipeLeft = dx < -GESTURE_CONFIG.SWIPE_THRESHOLD,
        isSwipeRight = dx > GESTURE_CONFIG.SWIPE_THRESHOLD;
      if (fingers === 1) {
        if (isSwipeRight && state.gesture.startX < GESTURE_CONFIG.EDGE_WIDTH)
          sendRequest("/api/hotkey", { keys: ["win", "w"] });
        else if (
          isSwipeLeft &&
          state.gesture.startX > window.innerWidth - GESTURE_CONFIG.EDGE_WIDTH
        )
          sendRequest("/api/hotkey", { keys: ["win", "n"] });
      } else if (fingers === 3) {
        if (isSwipeUp) sendRequest("/api/hotkey", { keys: ["win", "tab"] });
        else if (isSwipeDown)
          sendRequest("/api/hotkey", { keys: ["win", "d"] });
        else if (isSwipeLeft)
          sendRequest("/api/hotkey", { keys: ["alt", "shift", "tab"] });
        else if (isSwipeRight)
          sendRequest("/api/hotkey", { keys: ["alt", "tab"] });
      } else if (fingers === 4) {
        if (isSwipeLeft)
          sendRequest("/api/hotkey", { keys: ["ctrl", "win", "right"] });
        else if (isSwipeRight)
          sendRequest("/api/hotkey", { keys: ["ctrl", "win", "left"] });
      }
    },
    { passive: false }
  );

  document.querySelectorAll(".special-key").forEach((button) => {
    const key = button.dataset.key;
    button.addEventListener("touchstart", (e) => {
      e.preventDefault();
      state.longPressTimeout = setTimeout(() => {
        state.longPressTimeout = null;
        state.stickyKeys.has(key)
          ? state.stickyKeys.delete(key)
          : state.stickyKeys.add(key);
        button.classList.toggle("sticky");
      }, 300);
    });
    button.addEventListener("touchend", (e) => {
      if (state.longPressTimeout) {
        clearTimeout(state.longPressTimeout);
        if (state.stickyKeys.size > 0) {
          sendRequest("/api/hotkey", { keys: [...state.stickyKeys, key] });
          document
            .querySelectorAll(".special-key.sticky")
            .forEach((b) => b.classList.remove("sticky"));
          state.stickyKeys.clear();
        } else {
          sendRequest("/api/key_action", { key });
        }
      }
    });
  });

  liveKeyboardInput.addEventListener("keydown", (e) => {
    const isSpecialKey = e.key.length > 1;
    if (isSpecialKey) {
      e.preventDefault();
      if (state.stickyKeys.size > 0) {
        const keys = [...state.stickyKeys, e.key];
        sendRequest("/api/hotkey", { keys });
      } else {
        sendRequest("/api/key_action", { key: e.key });
      }
    }
  });

  liveKeyboardInput.addEventListener("input", (e) => {
    const typedText = e.data;
    if (typedText) {
      sendRequest("/api/key_action", { key: typedText });
    }

    liveKeyboardInput.value = "";
  });

  document
    .getElementById("fullscreen-button")
    .addEventListener("click", async () => {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        if ("wakeLock" in navigator)
          state.wakeLock = await navigator.wakeLock.request("screen");
      } else {
        await document.exitFullscreen();
        if (state.wakeLock) {
          state.wakeLock.release();
          state.wakeLock = null;
        }
      }
    });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector(".nav-btn.active").classList.remove("active");
      button.classList.add("active");
      const targetPanel = document.getElementById(button.dataset.panel);
      document.querySelector(".panel.active").classList.remove("active");
      targetPanel.classList.add("active");
      if (targetPanel.id === "keyboard-panel") {
        liveKeyboardInput.focus();
      }
    });
  });

  document.querySelectorAll(".media-btn").forEach((button) => {
    button.addEventListener("click", () =>
      sendRequest("/api/hotkey", { keys: [button.dataset.action] })
    );
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "AudioVolumeUp") {
      e.preventDefault();
      sendRequest("/api/hotkey", { keys: ["volumeup"] });
    } else if (e.key === "AudioVolumeDown") {
      e.preventDefault();
      sendRequest("/api/hotkey", { keys: ["volumedown"] });
    }
  });

  async function init() {
    try {
      const res = await fetch("/api/connect", { method: "POST" });
      const data = await res.json();
      updateStatus(res.ok, data.message);
      if (res.ok) {
        if (typeof DeviceOrientationEvent.requestPermission === "function") {
          DeviceOrientationEvent.requestPermission().then((p) => {
            if (p === "granted")
              window.addEventListener(
                "deviceorientation",
                handleOrientation,
                true
              );
          });
        } else {
          window.addEventListener("deviceorientation", handleOrientation, true);
        }
      }
    } catch (error) {
      updateStatus(false, "Server Not Found");
    }
  }

  document
    .getElementById("keyboard-panel")
    .addEventListener("click", () => liveKeyboardInput.focus());
  init();
});
