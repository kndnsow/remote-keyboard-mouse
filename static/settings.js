document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("settings-form");
  const toast = document.getElementById("toast");

  async function loadSettings() {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error("Failed to load settings");
      const settings = await response.json();
      for (const key in settings) {
        const input = document.getElementById(key);
        if (input) input.value = settings[key];
      }
    } catch (error) {
      showToast("Error loading settings", true);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const newSettings = Object.fromEntries(formData.entries());

    [
      "port",
      "mouse_sensitivity",
      "touchpad_sensitivity",
      "scroll_sensitivity",
      "cooldown_seconds",
    ].forEach((key) => {
      if (newSettings[key]) newSettings[key] = parseInt(newSettings[key], 10);
    });

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.message || "Failed to save settings");

      if (data.new_port) {
        showToast(
          `Port changed! Restarting and redirecting to port ${data.new_port}...`
        );

        setTimeout(() => {
          const newUrl = `${window.location.protocol}//${window.location.hostname}:${data.new_port}/settings`;
          window.location.href = newUrl;
        }, 2000);
      } else {
        showToast("Settings saved successfully!");
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, true);
    }
  });

  let toastTimeout;
  function showToast(message, isError = false) {
    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.style.backgroundColor = isError ? "#f44336" : "#4caf50";
    toast.classList.add("show");
    toastTimeout = setTimeout(() => {
      toast.classList.remove("show");
    }, 4000);
  }

  loadSettings();
});
