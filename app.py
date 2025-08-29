import sys
import os
import socket
import threading
import ssl
import json
import webbrowser
import configparser
from datetime import datetime, timedelta
import winreg

import subprocess

import pyautogui
from flask import Flask, request, send_from_directory, jsonify
from pystray import Icon as pystray_icon, Menu as pystray_menu, MenuItem as pystray_item
from PIL import Image
import qrcode
from pynput import mouse, keyboard

def resource_path(relative_path):
    try: base_path = sys._MEIPASS
    except Exception: base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

app_state = {
    "connected_device_ip": None, "last_physical_input_time": None, "cooldown_seconds": 0,
    "mouse_sensitivity": 50, "mouse_max_speed": 5, "air_mouse_last_orientation": None,
    "current_port": 4443
}
CONFIG_FILE = "config.ini"
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0
pyautogui_lock = threading.Lock()
app = Flask(__name__, static_folder=resource_path("static"))

def load_config():
    config = configparser.ConfigParser()
    if not config.read(CONFIG_FILE):
        config["SERVER"] = {"port": "4443"}
        config["SETTINGS"] = {"mouse_sensitivity": "50", "touchpad_sensitivity": "5", "cooldown_seconds": "0", "startup": "False"}
        config["DEVICES"] = {"blocked_ips": ""}
        with open(CONFIG_FILE, "w") as configfile: config.write(configfile)
    
    app_state["mouse_sensitivity"] = config.getint("SETTINGS", "mouse_sensitivity")
    app_state["mouse_max_speed"] = config.getint("SETTINGS", "touchpad_sensitivity")
    app_state["cooldown_seconds"] = config.getint("SETTINGS", "cooldown_seconds")
    app_state["current_port"] = config.getint("SERVER", "port")
    return config

config = load_config()

def restart_app():
    """Spawns a new instance of the app and exits the current one."""
    print("Restarting application...")
    try:

        executable = sys.executable
        args = [sys.argv[0]]
        

        if not executable.endswith('.exe'):

            subprocess.Popen([executable] + args)
        else:

            subprocess.Popen([executable])
            

        exit_app(None)
    except Exception as e:
        print(f"Failed to restart: {e}")

def toggle_startup(icon, item):
    global config
    app_name = "RemoteMouse"
    executable_path = sys.executable

    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_ALL_ACCESS) as registry_key:
            if is_startup_enabled():

                winreg.DeleteValue(registry_key, app_name)
                config.set("SETTINGS", "startup", "False")
                print("Removed from startup via registry.")
            else:

                winreg.SetValueEx(registry_key, app_name, 0, winreg.REG_SZ, f'"{executable_path}"')
                config.set("SETTINGS", "startup", "True")
                print("Added to startup via registry.")
    except Exception as e:
        print(f"Error modifying startup registry: {e}")

    with open(CONFIG_FILE, 'w') as configfile:
        config.write(configfile)

    icon.update_menu()

@app.route("/")
def index(): return send_from_directory(resource_path("."), "index.html")
@app.route("/settings")
def settings_page(): return send_from_directory(resource_path("."), "settings.html")

def is_device_allowed(remote_addr):
    blocked_ips = [ip.strip() for ip in config.get("DEVICES", "blocked_ips", fallback="").split(",") if ip.strip()]
    if remote_addr in blocked_ips: return False
    if app_state["connected_device_ip"] is None:
        app_state["connected_device_ip"] = remote_addr; print(f"Device connected: {remote_addr}"); return True
    return app_state["connected_device_ip"] == remote_addr
@app.before_request
def check_device_and_cooldown():
    whitelisted_paths = ['/static', '/', '/settings', '/api/settings', '/api/connect']
    if any(request.path.startswith(p) for p in whitelisted_paths): return
    if not is_device_allowed(request.remote_addr): return jsonify({"status": "error", "message": "Another device is already connected."}), 403
    if app_state["last_physical_input_time"]:
        cooldown_end_time = app_state["last_physical_input_time"] + timedelta(seconds=app_state["cooldown_seconds"])
        if datetime.now() < cooldown_end_time:
            remaining = (cooldown_end_time - datetime.now()).total_seconds()
            return jsonify({"status": "cooldown", "message": f"Cooldown: {remaining:.1f}s"}), 429
@app.route("/api/connect", methods=["POST"])
def api_connect():
    app_state["air_mouse_last_orientation"] = None
    if is_device_allowed(request.remote_addr): return jsonify({"status": "ok", "message": "Device connected successfully."})
    return jsonify({"status": "error", "message": "Connection refused."}), 403
@app.route("/api/airmouse", methods=["POST"])
def api_airmouse():
    data = request.json
    if data.get("active") and "orientation" in data: move_mouse_from_orientation(data["orientation"])
    else: app_state["air_mouse_last_orientation"] = None
    return jsonify({"status": "ok"})
@app.route("/api/touchpad", methods=["POST"])
def api_touchpad():
    data = request.json; action = data.get("action")
    with pyautogui_lock:
        if action == "move": pyautogui.move(data.get("dx", 0) * app_state["mouse_max_speed"], data.get("dy", 0) * app_state["mouse_max_speed"])
        elif action == "left_click": pyautogui.click(button='left')
        elif action == "right_click": pyautogui.click(button='right')
        elif action == "scroll": pyautogui.scroll(int(data.get("dy", 0) * -1))
    return jsonify({"status": "ok"})
@app.route("/api/key_action", methods=["POST"])
def api_key_action():
    data = request.json; key = data.get("key")
    if not key: return jsonify({"status": "error"}), 400
    with pyautogui_lock:
        try:
            if len(key) == 1: pyautogui.write(key)
            else: pyautogui.press(key.lower())
        except Exception as e: print(f"Key action failed for '{key}': {e}")
    return jsonify({"status": "ok"})
@app.route("/api/hotkey", methods=["POST"])
def api_hotkey():
    data = request.json; keys = data.get("keys")
    if not keys or (isinstance(keys, list) and len(keys) < 1): return jsonify({"status": "error"}), 400
    with pyautogui_lock:
        if len(keys) > 1: pyautogui.hotkey(*keys)
        else: pyautogui.press(keys[0])
    return jsonify({"status": "ok"})
@app.route("/api/settings", methods=["POST"])
def api_settings():
    global config
    new_settings = request.json
    new_port = int(new_settings.get("port", app_state["current_port"]))
    port_changed = new_port != app_state["current_port"]

    for key, value in new_settings.items():
        if config.has_option("SETTINGS", key): config.set("SETTINGS", key, str(value))
        elif config.has_option("DEVICES", key): config.set("DEVICES", key, str(value))
        elif config.has_option("SERVER", key): config.set("SERVER", key, str(value))
    with open(CONFIG_FILE, 'w') as configfile: config.write(configfile)
    
    if port_changed:
        threading.Timer(0.5, restart_app).start()
        return jsonify({"status": "ok", "message": "Port changed. Restarting server...", "new_port": new_port})
    else:
        load_config(); print("Settings updated and reloaded.")
        return jsonify({"status": "ok", "message": "Settings saved.", "new_port": None})
@app.route("/api/settings", methods=["GET"])
def get_api_settings():
    settings = dict(config.items("SETTINGS")); settings.update(dict(config.items("DEVICES"))); settings.update(dict(config.items("SERVER")))
    return jsonify(settings)

def move_mouse_from_orientation(orientation):
    alpha, beta = orientation.get("alpha"), orientation.get("beta")
    if alpha is None or beta is None: return
    last_orientation = app_state["air_mouse_last_orientation"]
    if last_orientation is None: app_state["air_mouse_last_orientation"] = orientation; return
    delta_alpha = alpha - last_orientation["alpha"]
    if delta_alpha > 180: delta_alpha -= 360
    if delta_alpha < -180: delta_alpha += 360
    delta_beta = beta - last_orientation["beta"]
    app_state["air_mouse_last_orientation"] = orientation
    sensitivity = app_state["mouse_sensitivity"] / 5.0
    dx, dy = int(-delta_alpha * sensitivity), int(-delta_beta * sensitivity)
    if dx != 0 or dy != 0:
        with pyautogui_lock: pyautogui.move(dx, dy)

def on_physical_input(event_type):
    if pyautogui_lock.locked(): return
    app_state["last_physical_input_time"] = datetime.now()
def start_input_listeners():
    mouse_listener = mouse.Listener(on_move=lambda x,y: on_physical_input("move"), on_click=lambda x,y,b,p: on_physical_input("click"), on_scroll=lambda x,y,dx,dy: on_physical_input("scroll"))
    keyboard_listener = keyboard.Listener(on_press=lambda k: on_physical_input("press"))
    mouse_listener.start(); keyboard_listener.start()
def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.1)
    try: s.connect(('10.255.255.255', 1)); IP = s.getsockname()[0]
    except Exception: IP = '127.0.0.1'
    finally: s.close()
    return IP

def run_flask_app():
    port = app_state["current_port"]
    try:
        cert, key = resource_path("cert.pem"), resource_path("key.pem")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(certfile=cert, keyfile=key)
        app.run(host="0.0.0.0", port=port, ssl_context=context, debug=False, use_reloader=False)
    except Exception as e:
        print(f"Failed to start server: {e}")
        if 'tray_icon' in globals() and tray_icon: tray_icon.stop()

def show_qr_code(icon):
    url = f"https://{get_local_ip()}:{app_state['current_port']}"; qr_img = qrcode.make(url)
    threading.Thread(target=lambda: qr_img.show(title="Scan to Connect")).start()
def open_settings_page(icon):
    webbrowser.open(f"https://{get_local_ip()}:{app_state['current_port']}/settings")
def exit_app(icon):
    print("Exiting...")
    if icon: icon.stop()
    os._exit(0)

def is_startup_enabled():
    app_name = "RemoteMouse"
    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as registry_key:
            value, _ = winreg.QueryValueEx(registry_key, app_name)
            return True if value else False
    except FileNotFoundError:
        return False
    except Exception:
        return False

def setup_tray_icon():
    global tray_icon, config
    try:
        image = Image.open(resource_path("static/icon.ico"))
    except:
        image = Image.new('RGB', (64, 64), color='black')

    menu = pystray_menu(
        pystray_item('Show QR Code', show_qr_code, default=True),
        pystray_item('Settings', open_settings_page),
        pystray_item('Startup with Windows', toggle_startup, checked=lambda item: is_startup_enabled()),
        pystray_menu.SEPARATOR,
        pystray_item('Exit', exit_app)
    )

    tray_icon = pystray_icon("RemoteMouse", image, title="Remote Keyboard & Mouse", menu=menu)
    tray_icon.run()

if __name__ == "__main__":
    threading.Thread(target=run_flask_app, daemon=True).start()
    threading.Thread(target=start_input_listeners, daemon=True).start()
    print("Remote Keyboard & Mouse server is running.")
    setup_tray_icon()