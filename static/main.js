document.addEventListener("DOMContentLoaded", () => {
  const state = {
    isConnected: false,
    isAirMouseOn: false,
    stickyKeys: new Set(),
    longPressTimeout: null,
    wakeLock: null,

    currentGesture: {
      type: "none",
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      startDist: 0,
      lastAvgY: 0,
      timeoutId: null,
      actioned: false,
    },
    lastTapEndTime: 0,
    singleClickTimeoutId: null,
    isLeftClickHolding: false,
  };

  const airMouseToggle = document.getElementById("air-mouse-toggle");
  const touchpadArea = document.getElementById("touchpad-area");
  const liveKeyboardInput = document.getElementById("live-keyboard-input");

  const GESTURE_CONFIG = {
    EDGE_WIDTH: 50,
    SWIPE_THRESHOLD: 60,
    RIGHT_CLICK_HOLD_DURATION: 400,

    DOUBLE_TAP_WINDOW: 300,
    TAP_MAX_MOVEMENT: 20,
    PINCH_VS_SCROLL_SENSITIVITY: 2,
  };

  async function sendRequest(endpoint, body) {
    if (!state.isConnected) return;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        const statusText = document.getElementById("status-text");
        if (res.status === 429) statusText.textContent = data.message;
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

  function getTouchDistance(touches) {
    if (touches.length < 2) return 0;
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );
  }

  function resetGestureState() {
    clearTimeout(state.currentGesture.timeoutId);
    if (state.isLeftClickHolding) {
      sendRequest("/api/touchpad", { action: "mouse_up" });
      state.isLeftClickHolding = false;
    }
    state.currentGesture = { type: "none", actioned: false, timeoutId: null };
  }

  touchpadArea.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const touches = e.touches;
      const currentTime = Date.now();

      clearTimeout(state.singleClickTimeoutId);

      resetGestureState();

      const gesture = state.currentGesture;
      gesture.startX = touches[0].clientX;
      gesture.startY = touches[0].clientY;
      gesture.lastX = touches[0].clientX;
      gesture.lastY = touches[0].clientY;

      if (touches.length === 1) {
        if (
          currentTime - state.lastTapEndTime <
          GESTURE_CONFIG.DOUBLE_TAP_WINDOW
        ) {
          gesture.type = "drag_pending";
        } else {
          gesture.type = "single_touch_pending";
          gesture.timeoutId = setTimeout(() => {
            sendRequest("/api/touchpad", { action: "right_click" });
            gesture.actioned = true;
          }, GESTURE_CONFIG.RIGHT_CLICK_HOLD_DURATION);
        }
      } else if (touches.length === 2) {
        gesture.type = "two_finger_pending";
        gesture.startDist = getTouchDistance(touches);
        gesture.lastAvgY = (touches[0].clientY + touches[1].clientY) / 2;
      } else if (touches.length >= 3) {
        gesture.type = "swipe_pending";
      }
    },
    { passive: false }
  );

  touchpadArea.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const touches = e.touches;
      const gesture = state.currentGesture;

      clearTimeout(gesture.timeoutId);

      const totalMovement = Math.hypot(
        touches[0].clientX - gesture.startX,
        touches[0].clientY - gesture.startY
      );

      if (
        totalMovement < GESTURE_CONFIG.TAP_MAX_MOVEMENT &&
        gesture.type !== "scroll" &&
        gesture.type !== "pinch"
      ) {
        return;
      }

      if (gesture.type === "drag_pending") {
        sendRequest("/api/touchpad", { action: "mouse_down" });
        state.isLeftClickHolding = true;
        gesture.type = "drag_active";
      } else if (gesture.type === "single_touch_pending") {
        gesture.type = "move";
      }

      if (gesture.type === "drag_active" || gesture.type === "move") {
        if (touches.length !== 1) return;
        const dx = touches[0].clientX - gesture.lastX;
        const dy = touches[0].clientY - gesture.lastY;
        sendRequest("/api/touchpad", { action: "move", dx, dy });
        gesture.lastX = touches[0].clientX;
        gesture.lastY = touches[0].clientY;
        gesture.actioned = true;
      } else if (gesture.type === "two_finger_pending") {
        if (touches.length !== 2) return;
        const currentDist = getTouchDistance(touches);
        const currentAvgY = (touches[0].clientY + touches[1].clientY) / 2;
        const deltaDist = Math.abs(currentDist - gesture.startDist);
        const deltaY = Math.abs(currentAvgY - gesture.lastAvgY);

        if (deltaDist > GESTURE_CONFIG.PINCH_VS_SCROLL_SENSITIVITY * deltaY) {
          gesture.type = "pinch";
        } else {
          gesture.type = "scroll";
        }
      }

      if (gesture.type === "scroll") {
        if (touches.length !== 2) return;
        const currentAvgY = (touches[0].clientY + touches[1].clientY) / 2;
        const dy = currentAvgY - gesture.lastAvgY;
        sendRequest("/api/touchpad", { action: "scroll", dy });
        gesture.lastAvgY = currentAvgY;
        gesture.actioned = true;
      } else if (gesture.type === "pinch") {
        if (touches.length !== 2) return;
        const currentDist = getTouchDistance(touches);
        const distRatio = currentDist / gesture.startDist;
        if (distRatio > 1.05) {
          sendRequest("/api/hotkey", { keys: ["ctrl", "+"] });
          gesture.startDist = currentDist;
        } else if (distRatio < 0.95) {
          sendRequest("/api/hotkey", { keys: ["ctrl", "-"] });
          gesture.startDist = currentDist;
        }
        gesture.actioned = true;
      }
    },
    { passive: false }
  );

  touchpadArea.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      const gesture = state.currentGesture;
      clearTimeout(gesture.timeoutId);

      if (!gesture.actioned) {
        if (gesture.type === "single_touch_pending") {
          state.singleClickTimeoutId = setTimeout(() => {
            sendRequest("/api/touchpad", { action: "left_click" });
          }, GESTURE_CONFIG.DOUBLE_TAP_WINDOW);
        } else if (gesture.type === "drag_pending") {
          sendRequest("/api/touchpad", { action: "double_click" });
        } else if (gesture.type === "swipe_pending") {
          const touch = e.changedTouches[0];
          const dx = touch.clientX - gesture.startX;
          const dy = touch.clientY - gesture.startY;
          const fingers = e.targetTouches.length + e.changedTouches.length;

          const isSwipeUp = dy < -GESTURE_CONFIG.SWIPE_THRESHOLD,
            isSwipeDown = dy > GESTURE_CONFIG.SWIPE_THRESHOLD;
          const isSwipeLeft = dx < -GESTURE_CONFIG.SWIPE_THRESHOLD,
            isSwipeRight = dx > GESTURE_CONFIG.SWIPE_THRESHOLD;

          if (fingers === 3) {
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
        }
      }

      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        state.lastTapEndTime = Date.now();
      } else {
        state.lastTapEndTime = 0;
      }

      if (e.touches.length === 0) {
        resetGestureState();
      }
    },
    { passive: false }
  );

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
        sendRequest("/api/hotkey", { keys: [...state.stickyKeys, e.key] });
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
