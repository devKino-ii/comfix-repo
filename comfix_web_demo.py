#!/usr/bin/env python3
"""Local ComFix web demo. Run with: python comfix_web_demo.py"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import comfix_demo as engine

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web_demo"
AUTH_DB = ROOT / "comfix_accounts.sqlite3"
HOST = os.environ.get("COMFIX_HOST", "127.0.0.1")
PORT = int(os.environ.get("COMFIX_PORT", "8000"))
PASSWORD_ROUNDS = 310_000
SESSIONS = {}
LOCK = threading.RLock()
DB = engine.load()
_boot = time.time()
for _r in DB["reports"]:
    _r.setdefault("created_at", _boot + _r["t"] * 3600)
    if _r["status"] == "Resolved":
        _r.setdefault("resolved_at", _r["created_at"] + 6 * 3600)
engine.save(DB)


def account_connection():
    connection = sqlite3.connect(AUTH_DB)
    connection.row_factory = sqlite3.Row
    return connection


def password_record(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ROUNDS)
    return salt.hex(), digest.hex()


def setup_accounts():
    with account_connection() as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS profiles (username TEXT PRIMARY KEY, full_name TEXT, address TEXT, phone TEXT)")
        connection.execute("CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL)")
        count = connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        if not count:
            username = os.environ.get("COMFIX_ADMIN_USERNAME", "office")
            password = os.environ.get("COMFIX_ADMIN_PASSWORD", "comfix-admin")
            salt, digest = password_record(password)
            connection.execute("INSERT INTO accounts VALUES (?, ?, ?, 'admin')", (username, salt, digest))


def get_account(username):
    with account_connection() as connection:
        return connection.execute("SELECT username, salt, password_hash, role FROM accounts WHERE username = ?", (username,)).fetchone()


def get_profile(username):
    with account_connection() as connection:
        row = connection.execute("SELECT full_name, address, phone FROM profiles WHERE username = ?", (username,)).fetchone()
    return {"fullName": row[0] or "", "address": row[1] or "", "phone": row[2] or ""} if row else {"fullName": "", "address": "", "phone": ""}


def reporter_info(username, role):
    profile = get_profile(username)
    name = profile["fullName"] or username
    if role == "admin":
        return {"name": name, "address": profile["address"], "phone": profile["phone"]}
    return {"name": name.split()[0]}


def add_citizen(username, password, role="citizen"):
    salt, digest = password_record(password)
    try:
        with account_connection() as connection:
            connection.execute("INSERT INTO accounts VALUES (?, ?, ?, ?)", (username, salt, digest, role))
        return True
    except sqlite3.IntegrityError:
        return False


def make_session(account):
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"username": account["username"], "role": account["role"]}
    return token


def current_user(handler):
    cookie = SimpleCookie(handler.headers.get("Cookie", ""))
    morsel = cookie.get("comfix_session")
    return SESSIONS.get(morsel.value) if morsel else None


def group_data(group, rank=None, user=None):
    rs = group["rs"]
    me = user["username"] if user else None
    authors = []
    for report in rs:
        if report.get("author") and report["author"] not in authors:
            authors.append(report["author"])
    return {
        "createdAt": min([r["created_at"] for r in rs if r.get("created_at")] or [0]),
        "resolvedAt": max([r["resolved_at"] for r in rs if r.get("resolved_at")] or [0]) if group["st"] == 3 else None,
        "image": next((r.get("image") for r in rs if r.get("image")), None),
        "reporters": [reporter_info(a, user["role"] if user else "citizen") for a in authors],
        "mine": any(r.get("author") == me and not r.get("support") for r in rs),
        "supported": any(r.get("author") == me and r.get("support") for r in rs),
        "ids": [report["id"] for report in group["rs"]],
        "title": group["title"],
        "category": group["cat"],
        "severity": group["sev"],
        "count": group["n"],
        "status": engine.STATUSES[group["st"]],
        "priority": round(group["pr"], 1),
        "factors": {key: round(value, 2) for key, value in group["f"].items()},
        "ageHours": group["age"],
        "pin": group["pin"],
        "reports": [{"id": report["id"], "text": report["text"], "createdHour": report["t"]} for report in group["rs"]],
        "rank": rank,
    }


def dashboard_data(user=None):
    with LOCK:
        all_groups = engine.groups(DB["reports"], DB["now"])
        opened = [group for group in all_groups if group["st"] < 3]
        ranked = sorted(opened, key=lambda group: -group["pr"])
        ranked_ids = {tuple(report["id"] for report in group["rs"]): i for i, group in enumerate(ranked, 1)}
        open_reports = [group_data(group, ranked_ids.get(tuple(report["id"] for report in group["rs"])), user) for group in ranked]
        closed_reports = [group_data(group, None, user) for group in all_groups if group["st"] == 3]
        received = sum(1 for r in DB["reports"] if not r.get("support"))
        return {"reportsReceived": received, "openReportCount": len(opened),
            "resolvedReportCount": len(closed_reports), "openReports": open_reports,
            "resolvedReports": closed_reports}


def clean_text(value, limit=500):
    return value.strip()[:limit] if isinstance(value, str) else ""


def valid_pin(pin):
    if pin is None:
        return None
    if not isinstance(pin, list) or len(pin) != 2:
        raise ValueError("Location must contain latitude and longitude.")
    latitude, longitude = float(pin[0]), float(pin[1])
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("Location is outside the valid map range.")
    return [latitude, longitude]


class DemoHandler(BaseHTTPRequestHandler):
    server_version = "ComFixDemo/1.0"

    def send_json(self, payload, status=HTTPStatus.OK, cookie=None, clear_cookie=False):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", f"comfix_session={cookie}; HttpOnly; SameSite=Lax; Path=/")
        elif clear_cookie:
            self.send_header("Set-Cookie", "comfix_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 450_000:
            raise ValueError("Request is too large.")
        return json.loads(self.rfile.read(length) or b"{}")

    def require_user(self, role=None):
        user = current_user(self)
        if not user:
            self.send_json({"error": "Please sign in."}, HTTPStatus.UNAUTHORIZED)
            return None
        if role and user["role"] != role:
            self.send_json({"error": "This action is only available to the office."}, HTTPStatus.FORBIDDEN)
            return None
        return user

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.api_get(path)
        else:
            self.send_static(path)

    def api_get(self, path):
        if path == "/api/config":
            self.send_json({"googleMapsApiKey": os.environ.get("GOOGLE_MAPS_API_KEY", "")})
            return
        if path == "/api/session":
            self.send_json({"user": current_user(self)})
            return
        if path == "/api/dashboard":
            user = self.require_user()
            if user:
                self.send_json(dashboard_data(user))
            return
        if path == "/api/profile":
            user = self.require_user()
            if user:
                self.send_json(get_profile(user["username"]))
            return
        self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/register":
                self.register(payload)
            elif path == "/api/login":
                self.login(payload)
            elif path == "/api/logout":
                cookie = SimpleCookie(self.headers.get("Cookie", ""))
                morsel = cookie.get("comfix_session")
                if morsel:
                    SESSIONS.pop(morsel.value, None)
                self.send_json({"ok": True}, clear_cookie=True)
            elif path == "/api/reports":
                self.create_report(payload)
            elif path == "/api/profile":
                self.save_profile(payload)
            elif path == "/api/support":
                self.support(payload)
            elif path == "/api/status":
                self.update_status(payload)
            else:
                self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def register(self, payload):
        username = clean_text(payload.get("username"), 32)
        password = payload.get("password", "")
        if not 3 <= len(username) <= 32 or not all(ch.isalnum() or ch in "_.-" for ch in username):
            raise ValueError("Use a 3-32 character username with letters, numbers, . _ or -.")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
            raise ValueError("Password must be 8-128 characters.")
        code, role = payload.get("staffCode"), "citizen"
        if code:
            if not hmac.compare_digest(str(code), os.environ.get("COMFIX_STAFF_CODE", "morong-staff")):
                raise ValueError("That staff code isn't right.")
            role = "admin"
        if not add_citizen(username, password, role):
            self.send_json({"error": "That username is already taken."}, HTTPStatus.CONFLICT)
            return
        account = get_account(username)
        self.send_json({"user": {"username": username, "role": role}}, cookie=make_session(account))

    def login(self, payload):
        username = clean_text(payload.get("username"), 32)
        password = payload.get("password", "")
        account = get_account(username)
        if not account or not isinstance(password, str):
            self.send_json({"error": "Username or password is incorrect."}, HTTPStatus.UNAUTHORIZED)
            return
        _, digest = password_record(password, bytes.fromhex(account["salt"]))
        if not hmac.compare_digest(digest, account["password_hash"]):
            self.send_json({"error": "Username or password is incorrect."}, HTTPStatus.UNAUTHORIZED)
            return
        user = {"username": account["username"], "role": account["role"]}
        self.send_json({"user": user}, cookie=make_session(account))

    def create_report(self, payload):
        user = self.require_user("citizen")
        if not user:
            return
        profile = get_profile(user["username"])
        if not (profile["fullName"] and profile["address"]):
            raise ValueError("Add your name and address in Profile first.")
        image = payload.get("image")
        if image and not (isinstance(image, str) and image.startswith("data:image/jpeg;base64,") and len(image) <= 350_000):
            raise ValueError("The photo is too large or not a JPEG.")
        category = payload.get("category")
        severity = payload.get("severity")
        text = clean_text(payload.get("text"))
        pin = valid_pin(payload.get("pin"))
        if category not in engine.CATEGORIES:
            raise ValueError("Choose a report category.")
        if not isinstance(severity, int) or not 1 <= severity <= 5:
            raise ValueError("Choose a severity from 1 to 5.")
        if len(text) < 8:
            raise ValueError("Describe the issue in at least 8 characters.")
        with LOCK:
            report, group, reopened = engine.submit(DB, {"cat": category, "sev": severity, "text": text, "pin": pin})
            report["author"], report["image"], report["created_at"] = user["username"], image or None, time.time()
            engine.save(DB)
        self.send_json({"ticket": f"CF-{report['id']:03d}", "groupCount": group["n"], "reopened": reopened})

    def save_profile(self, payload):
        user = self.require_user()
        if not user:
            return
        name, address, phone = clean_text(payload.get("fullName"), 80), clean_text(payload.get("address"), 120), clean_text(payload.get("phone"), 20)
        if len(name) < 2 or len(address) < 4:
            raise ValueError("Enter your full name and your address in the community.")
        if phone and not all(ch.isdigit() or ch in "+-() " for ch in phone):
            raise ValueError("Phone can only contain digits, spaces, + - ( ).")
        with account_connection() as connection:
            connection.execute("INSERT INTO profiles VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET full_name=excluded.full_name, address=excluded.address, phone=excluded.phone", (user["username"], name, address, phone))
        self.send_json(get_profile(user["username"]))

    def support(self, payload):
        user = self.require_user("citizen")
        if not user:
            return
        target = set(payload.get("ids") or [])
        with LOCK:
            group = next((g for g in engine.groups(DB["reports"], DB["now"]) if {r["id"] for r in g["rs"]} == target), None)
            if not group or group["st"] == 3:
                raise ValueError("That report is no longer open.")
            if any(r.get("author") == user["username"] for r in group["rs"]):
                raise ValueError("You already sent or backed this report.")
            lead = group["rs"][0]
            DB["reports"].append(dict(id=DB["next_id"], cat=lead["cat"], sev=lead["sev"], text=lead["text"], t=DB["now"],
                                      status=engine.STATUSES[group["st"]], pin=lead["pin"], author=user["username"], support=True, created_at=time.time()))
            DB["next_id"] += 1
            engine.save(DB)
        self.send_json({"ok": True})

    def update_status(self, payload):
        if not self.require_user("admin"):
            return
        ids = payload.get("ids")
        status = payload.get("status")
        if not isinstance(ids, list) or not ids or status not in engine.STATUSES:
            raise ValueError("Choose a report and valid status.")
        with LOCK:
            target = set(ids)
            group = next((group for group in engine.groups(DB["reports"], DB["now"])
                          if {report["id"] for report in group["rs"]} == target), None)
            if not group:
                raise ValueError("That report is no longer available. Refresh and try again.")
            engine.set_status(group, status, DB)
            for r in group["rs"]:
                if status == "Resolved":
                    r["resolved_at"] = time.time()
                else:
                    r.pop("resolved_at", None)
            engine.save(DB)
        self.send_json({"ok": True})

    def send_static(self, path):
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in target.parents or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")


def main():
    setup_accounts()
    server = ThreadingHTTPServer((HOST, PORT), DemoHandler)
    print(f"ComFix web demo: http://{HOST}:{PORT}")
    print("Staff sign-up code: " + os.environ.get("COMFIX_STAFF_CODE", "morong-staff") + " (change with COMFIX_STAFF_CODE)")
    print("Demo admin login: office / comfix-admin (change with COMFIX_ADMIN_USERNAME and COMFIX_ADMIN_PASSWORD)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nComFix web demo stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()