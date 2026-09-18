#!/usr/bin/env python3
"""
LabSoft — License Key Generator (Developer Tool)
KEEP THIS FILE PRIVATE — never share with clients
"""

import base64
import os
import tkinter as tk
from tkinter import messagebox
from datetime import datetime, timedelta

from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.backends import default_backend

RSA_PRIVATE_KEY_PEM = b"""-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA14UifELm2Xaw1XMXR31zDL9TlKM4FIt1CqfUH2zaxb2GxctW
lv1QOFS9v+GAIKv6RvQ3EuRb5UcD2Qqi0pTuILJU2bEWiwbGegvkjkH3rQu3YXBi
Y4yVOASRS8tgbDMRAUE5F36BmBXXNElzRdvK/fNe/jXcXanht9VlDPqpiZo5pYD5
57xfdJoxR2spNIUjjU0Z+rXabj5WbmxLb4ZYBhRxvOgNEjNTEbRd/J0Y4wAy/KUB
MQgp+YbiKg6DHZF73e0AXsskHu7czsskR2LCdD0BSXWGiepVwK2p+XZjLX3DztIZ
8AFKX43ULXE/ZKemyEErUoYyVsxCj5DlatdHGQIDAQABAoIBADUDqdT5PAH4QU1w
LyTFxhw3oB6q+6uKFnNVj0dfpn0HvvQ+rYEctLP2nGpr1PG0fC8h+b4q8DP5AQhN
pnm4as8eLuMRvaLbOs1gyYr4zS0C+cv9MiacuUP7U6ZaU9CpyyAM5DdURhqcHMDe
5H0lsMxBJnfP1fIwTLbExkOoETYohtRIqpPIyF6+bMZfVTKj7UMgRe1QnqdxIZIP
8RctEQTPYfCEVseCLw4yce5lkVeL28RyW/yyzGWXEOhJ/dHF8MKrHAnviYoO8omb
qs3Gm4hjGXwQ0E1eKGbPhQnOWdqyvW1e7I8vd96dNFzZsBQPlbuA37IOZycaEv+d
Mv81kJUCgYEA/9iYIo/3wP/f6gjr3vm1K6wzvhlN7wMQAuNP3D0HFahGq8g0ETbq
Y5yF14jZOpjc4PepuxfRJf0G+hKMrYmcyyoImgsWEjabrgEhboSj6FPGF1oSYDVH
6ICBXizIYrc9ZDkHQR4VjXG9L5SOP72ThLAKkfSSVzjk5wphYMSQnv8CgYEA16ZU
UZA3JHVJZUrJXFVQX/CCi+x7PvY+ppONEXC+bSor/iP9L3wNvfQ6m5dDwNzBBM52
u7RFDUkpFU/qCVmmC2IYysxmviGs6SUwkk9Kw9jubZOxJV/7NwmEANNHkN9+eksa
hH72udzixzbsOdtD71tcGrGvjZlVrHL//usXMecCgYAkbD9sXDaXQVYtSUvbGI2U
RBWxsISJzFPRNW8/GWkSyjwVZJEVCk5gE/5x6seSMgTv+hIt0nwx/k2p+E4Svo6V
1cwXshBYU3HiWcLaqwNypcqDtIz9KVitXu4L7DAy7YdN51iDCrdixZh7V5jQtjp0
H2PB16GlzTG5Op8WWaWFHQKBgQCEvFF8HsuCOlsh6OWGWtDtLKn+HGJD/+fSOlID
YSUlJmcLt/U4jCAdQr3sVTAT/w0juz2kDbLPGbAa+SRx+udUbF4cPbIj57B5lTWP
aRT49YbUlarc+XY0izvgEiwjxR0hgybgVRHil05TFsBSYF8xbkeD+si23KG6UtK1
gti1EwKBgQCFcaS1OvE9T3VpxTdkxdjwa0z0O7/SpgE+L8visFAW+TM0ngiew15n
2wJSMLl3l7Lnc4MLVDC+BrMA+CUOMMRe5CIhiTnqGCjjrMDfmuX+xdkwulFcEzI/
ohAtQkuHamhbAGmjwt8oX8FuhBpyGSG6XPJJWdZCFYsEYLtcW9gwwA==
-----END RSA PRIVATE KEY-----"""

_SC_KEY = bytes.fromhex("477a4b74394b346b6c613277787963320000000000000000000000000000001f")

BG          = "#0f1117"
CARD        = "#1a1d27"
BORDER      = "#2a2d3e"
ACCENT      = "#4f8ef7"
ACCENT_DARK = "#3a6fd8"
SUCCESS     = "#22c55e"
ERROR       = "#ef4444"
WARNING     = "#f59e0b"
TEXT        = "#e2e8f0"
TEXT_DIM    = "#64748b"
TEXT_MUTED  = "#94a3b8"
WHITE       = "#ffffff"

FONT_MONO   = ("Consolas", 10)
FONT_BODY   = ("Segoe UI", 10)
FONT_BOLD   = ("Segoe UI", 10, "bold")
FONT_TITLE  = ("Segoe UI", 13, "bold")
FONT_HEADER = ("Segoe UI", 11, "bold")
FONT_SMALL  = ("Segoe UI", 8)


def decode_system_code(system_code: str) -> str:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    padded = system_code.strip().upper() + '=' * (-len(system_code) % 8)
    ct = base64.b32decode(padded)
    c = Cipher(algorithms.AES(_SC_KEY), modes.ECB(), backend=default_backend())
    dec = c.decryptor()
    pt = dec.update(ct) + dec.finalize()
    return pt.rstrip(b'\x00').decode()

def validate_machine_id(mid: str) -> bool:
    parts = mid.strip().upper().split('-')
    if len(parts) != 4:
        return False
    return all(len(p) == 4 and all(c in '0123456789ABCDEF' for c in p) for p in parts)

# ── Feature flags — must match FEATURE_* constants in app.py ──────────────────
FEATURE_APPOINTMENTS    = 0x0001
FEATURE_IMPORT_EXPORT   = 0x0002
FEATURE_BACKUP          = 0x0004
FEATURE_FORM_DESIGNER   = 0x0008
FEATURE_LAB_TEST_BILL   = 0x0010
FEATURE_TEST_CATALOG    = 0x0020
FEATURE_INTERPRETATIONS = 0x0040
FEATURE_TEST_STAGES     = 0x0080
FEATURE_OTHER_LAB_TESTS = 0x0100
FEATURE_COLLECTIONS     = 0x0200
FEATURE_REFERENCE_TABLES = 0x0400
FEATURE_CALCULATIONS    = 0x0800
FEATURE_WHATSAPP        = 0x1000
ALL_FEATURES = 0xFFFF

FEATURE_CHOICES = [
    ("Appointments",              FEATURE_APPOINTMENTS),
    ("Excel/PDF Import & Export", FEATURE_IMPORT_EXPORT),
    ("Backup & Restore",          FEATURE_BACKUP),
    ("Form Designer",             FEATURE_FORM_DESIGNER),
    ("Lab Test Bill",             FEATURE_LAB_TEST_BILL),
    ("Test Catalog",              FEATURE_TEST_CATALOG),
    ("Interpretations",           FEATURE_INTERPRETATIONS),
    ("Test Stages",               FEATURE_TEST_STAGES),
    ("Other Lab Tests",           FEATURE_OTHER_LAB_TESTS),
    ("Collections",               FEATURE_COLLECTIONS),
    ("Reference Tables",          FEATURE_REFERENCE_TABLES),
    ("Calculations",              FEATURE_CALCULATIONS),
    ("WhatsApp Sharing",          FEATURE_WHATSAPP),
]

# OR of every bit currently defined above — used to detect "every box ticked"
# so those keys can still use the older no-flags-byte full-access format.
_FULL_FEATURE_MASK = 0
for _label, _bit in FEATURE_CHOICES:
    _FULL_FEATURE_MASK |= _bit

def generate_key(machine_id: str, expiry_date: str, features: int = ALL_FEATURES) -> str:
    """features=ALL_FEATURES (default) generates a full-access key in the same
    format used before feature-gating existed, for clients on the full plan.
    Pass a specific bitmask (OR the FEATURE_* constants together) to issue a
    restricted low-price-tier key instead — always encoded as a 2-byte (v4)
    bitmask now, since the original 1-byte field is full (11 features defined)."""
    nonce = os.urandom(8)
    private_key = serialization.load_pem_private_key(
        RSA_PRIVATE_KEY_PEM, password=None, backend=default_backend()
    )
    if features == ALL_FEATURES or features == _FULL_FEATURE_MASK:
        # Keep issuing the plain full-access format for the common case —
        # functionally identical to a restricted key with all bits set, but
        # matches every key generated before this tool had feature flags.
        payload   = f"{machine_id}:{expiry_date}:".encode() + nonce
        signature = private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
        combined  = expiry_date.encode('ascii') + nonce + signature
    else:
        import struct
        feat_bytes = struct.pack('>H', features)   # v4: 2-byte big-endian bitmask
        payload   = f"{machine_id}:{expiry_date}:".encode() + nonce + feat_bytes
        signature = private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
        combined  = expiry_date.encode('ascii') + nonce + feat_bytes + signature
    return base64.b64encode(combined).decode()


class RoundedEntry(tk.Frame):
    def __init__(self, parent, placeholder="", show=None, font=None, **kwargs):
        super().__init__(parent, bg=CARD, **kwargs)
        self.placeholder = placeholder
        self.showing_placeholder = True
        self.entry = tk.Entry(
            self, bg="#252836", fg=TEXT_DIM, insertbackground=ACCENT,
            relief="flat", bd=0, font=font or FONT_BODY, show=show,
        )
        self.entry.pack(fill="x", ipady=8, ipadx=10, padx=1, pady=1)
        if placeholder:
            self.entry.insert(0, placeholder)
            self.entry.bind("<FocusIn>",  self._on_focus_in)
            self.entry.bind("<FocusOut>", self._on_focus_out)
        self.config(highlightbackground=BORDER, highlightcolor=ACCENT, highlightthickness=1)

    def _on_focus_in(self, e):
        if self.showing_placeholder:
            self.entry.delete(0, "end")
            self.entry.config(fg=TEXT)
            self.showing_placeholder = False
        self.config(highlightbackground=ACCENT)

    def _on_focus_out(self, e):
        if not self.entry.get():
            self.entry.insert(0, self.placeholder)
            self.entry.config(fg=TEXT_DIM)
            self.showing_placeholder = True
        self.config(highlightbackground=BORDER)

    def get(self):
        return "" if self.showing_placeholder else self.entry.get()

    def set(self, value):
        self.entry.delete(0, "end")
        self.entry.insert(0, value)
        self.entry.config(fg=TEXT)
        self.showing_placeholder = False


class StatusBadge(tk.Label):
    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=BG, font=FONT_SMALL, text="", **kwargs)

    def set_success(self, text): self.config(text=f"✓  {text}", fg=SUCCESS)
    def set_error(self,   text): self.config(text=f"✗  {text}", fg=ERROR)
    def set_info(self,    text): self.config(text=f"ℹ  {text}", fg=TEXT_DIM)
    def clear(self):             self.config(text="")


class KeygenApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("LabSoft — License Key Generator")
        self.configure(bg=BG)
        self.resizable(True, True)
        self.minsize(580, 600)

        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        w, h = 600, min(820, sh - 80)
        x = (sw - w) // 2
        y = (sh - h) // 2
        self.geometry(f"{w}x{h}+{x}+{y}")

        self.machine_id   = tk.StringVar()
        self.duration_var = tk.StringVar(value="365")
        self._key_for_save    = None
        self._expiry_for_save = None

        self._build_ui()

    def _build_ui(self):
        # ── Fixed header ─────────────────────────────────────
        hdr = tk.Frame(self, bg=CARD)
        hdr.pack(fill="x", side="top")

        tk.Frame(hdr, bg=ACCENT, height=3).pack(fill="x")
        inner_hdr = tk.Frame(hdr, bg=CARD, padx=28, pady=16)
        inner_hdr.pack(fill="x")

        tk.Label(inner_hdr, text="LabSoft", font=("Segoe UI", 20, "bold"),
                 bg=CARD, fg=ACCENT).pack(side="left")
        tk.Label(inner_hdr, text="  License Generator", font=("Segoe UI", 12),
                 bg=CARD, fg=TEXT_MUTED).pack(side="left", pady=(5, 0))
        tk.Label(inner_hdr, text="🔒 DEVELOPER ONLY", font=FONT_SMALL,
                 bg=CARD, fg=WARNING).pack(side="right", pady=(5, 0))
        tk.Frame(hdr, bg=BORDER, height=1).pack(fill="x")

        # ── Scrollable body ──────────────────────────────────
        outer = tk.Frame(self, bg=BG)
        outer.pack(fill="both", expand=True)

        self.canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scrollbar   = tk.Scrollbar(outer, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)

        self.body = tk.Frame(self.canvas, bg=BG, padx=28, pady=20)
        self._canvas_window = self.canvas.create_window((0, 0), window=self.body, anchor="nw")

        self.body.bind("<Configure>", self._on_frame_configure)
        self.canvas.bind("<Configure>", self._on_canvas_configure)

        # Mouse wheel scrolling
        self.canvas.bind_all("<MouseWheel>",       self._on_mousewheel)
        self.canvas.bind_all("<Button-4>",         self._on_mousewheel)
        self.canvas.bind_all("<Button-5>",         self._on_mousewheel)

        self._build_body(self.body)

    def _on_frame_configure(self, e):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas_configure(self, e):
        self.canvas.itemconfig(self._canvas_window, width=e.width)

    def _on_mousewheel(self, e):
        if e.num == 4:
            self.canvas.yview_scroll(-1, "units")
        elif e.num == 5:
            self.canvas.yview_scroll(1, "units")
        else:
            self.canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")

    def _build_body(self, body):
        # ── Step 1 ───────────────────────────────────────────
        self._section(body, "01", "Client System Code")
        tk.Label(body, text="Paste the System Code from the client's activation screen.",
                 font=FONT_BODY, bg=BG, fg=TEXT_MUTED, wraplength=520, justify="left",
                 ).pack(anchor="w", pady=(2, 8))

        self.sc_entry = RoundedEntry(body, placeholder="e.g. ABCDEFGH2345WXYZ")
        self.sc_entry.pack(fill="x")

        self.sc_status = StatusBadge(body)
        self.sc_status.pack(anchor="w", pady=(4, 0))

        tk.Button(body, text="Decode System Code →", font=FONT_BOLD,
                  bg=ACCENT, fg=WHITE, activebackground=ACCENT_DARK, activeforeground=WHITE,
                  relief="flat", bd=0, cursor="hand2", padx=18, pady=8,
                  command=self._decode).pack(anchor="w", pady=(10, 0))

        mid_row = tk.Frame(body, bg=BG)
        mid_row.pack(fill="x", pady=(12, 0))
        tk.Label(mid_row, text="Machine ID:", font=FONT_BODY, bg=BG, fg=TEXT_MUTED
                 ).pack(side="left")
        tk.Label(mid_row, textvariable=self.machine_id,
                 font=("Consolas", 11, "bold"), bg=BG, fg=ACCENT,
                 ).pack(side="left", padx=(10, 0))

        self._divider(body)

        # ── Step 2 ───────────────────────────────────────────
        self._section(body, "02", "License Duration")

        for label, val in [
            ("1 Year  (365 days)",  "365"),
            ("6 Months (180 days)", "180"),
            ("3 Months  (90 days)", "90"),
            ("Custom Date",         "custom"),
        ]:
            tk.Radiobutton(body, text=label, variable=self.duration_var, value=val,
                           font=FONT_BODY, bg=BG, fg=TEXT, activebackground=BG,
                           activeforeground=ACCENT, selectcolor=BG,
                           command=self._on_duration_change,
                           ).pack(anchor="w", pady=2)

        self.custom_row = tk.Frame(body, bg=BG)
        tk.Label(self.custom_row, text="Expiry Date (YYYY-MM-DD):",
                 font=FONT_BODY, bg=BG, fg=TEXT_MUTED).pack(side="left")
        self.custom_entry = RoundedEntry(self.custom_row, placeholder="2027-12-31")
        self.custom_entry.pack(side="left", padx=(10, 0))
        # hidden by default

        self.dur_status = StatusBadge(body)
        self.dur_status.pack(anchor="w", pady=(4, 0))

        self._divider(body)

        # ── Step 3 ───────────────────────────────────────────
        self._section(body, "03", "Features (this client's plan)")
        tk.Label(body, text="Untick a feature to lock it for this client (low-price tier). Leave all ticked for full access.",
                 font=FONT_BODY, bg=BG, fg=TEXT_MUTED, wraplength=520, justify="left",
                 ).pack(anchor="w", pady=(2, 8))

        self.feature_vars = {}
        for label, bit in FEATURE_CHOICES:
            var = tk.BooleanVar(value=True)
            self.feature_vars[bit] = var
            tk.Checkbutton(body, text=label, variable=var,
                           font=FONT_BODY, bg=BG, fg=TEXT, activebackground=BG,
                           activeforeground=ACCENT, selectcolor=CARD,
                           ).pack(anchor="w", pady=1)

        self._divider(body)

        # ── Step 4 ───────────────────────────────────────────
        self._section(body, "04", "Generate License Key")

        tk.Button(body, text="⚡  Generate License Key",
                  font=("Segoe UI", 11, "bold"), bg=SUCCESS, fg=WHITE,
                  activebackground="#16a34a", activeforeground=WHITE,
                  relief="flat", bd=0, cursor="hand2", padx=24, pady=10,
                  command=self._generate).pack(anchor="w", pady=(8, 0))

        self.gen_status = StatusBadge(body)
        self.gen_status.pack(anchor="w", pady=(6, 0))

        # Key output box
        key_lbl_row = tk.Frame(body, bg=BG)
        key_lbl_row.pack(fill="x", pady=(14, 4))
        tk.Label(key_lbl_row, text="License Key", font=FONT_HEADER, bg=BG, fg=TEXT
                 ).pack(side="left")
        tk.Button(key_lbl_row, text="Copy", font=FONT_SMALL, bg=BORDER, fg=TEXT_MUTED,
                  activebackground=ACCENT, activeforeground=WHITE,
                  relief="flat", bd=0, cursor="hand2", padx=10, pady=4,
                  command=self._copy_key).pack(side="right")

        key_box_frame = tk.Frame(body, bg=BORDER, padx=1, pady=1)
        key_box_frame.pack(fill="x")

        self.key_text = tk.Text(
            key_box_frame, height=5, font=("Consolas", 9),
            bg="#1e2130", fg=SUCCESS, relief="flat", bd=0,
            wrap="word", state="disabled", insertbackground=ACCENT,
        )
        self.key_text.pack(fill="x", padx=8, pady=8)

        self.save_btn = tk.Button(
            body, text="💾  Save License Record", font=FONT_BOLD,
            bg=CARD, fg=TEXT_MUTED, activebackground=BORDER, activeforeground=TEXT,
            relief="flat", bd=0, cursor="hand2", padx=18, pady=8,
            command=self._save, state="disabled",
        )
        self.save_btn.pack(anchor="w", pady=(12, 0))

        # Footer
        tk.Frame(body, bg=BORDER, height=1).pack(fill="x", pady=(24, 8))
        tk.Label(body, text="⚠  This tool is confidential. Do not distribute.",
                 font=FONT_SMALL, bg=BG, fg=TEXT_DIM).pack(anchor="w", pady=(0, 16))

    # ── Helpers ───────────────────────────────────────────────
    def _section(self, parent, num, title):
        row = tk.Frame(parent, bg=BG)
        row.pack(fill="x", pady=(16, 6))
        tk.Label(row, text=f" {num} ", font=("Consolas", 9, "bold"),
                 bg=ACCENT, fg=WHITE).pack(side="left")
        tk.Label(row, text=f"  {title}", font=FONT_TITLE, bg=BG, fg=TEXT
                 ).pack(side="left")

    def _divider(self, parent):
        tk.Frame(parent, bg=BORDER, height=1).pack(fill="x", pady=(20, 0))

    def _on_duration_change(self):
        if self.duration_var.get() == "custom":
            self.custom_row.pack(fill="x", pady=(8, 0), before=self.dur_status)
        else:
            self.custom_row.pack_forget()
        self.dur_status.clear()

    def _decode(self):
        sc = self.sc_entry.get().strip()
        if not sc:
            self.sc_status.set_error("Please enter the System Code.")
            return
        try:
            mid = decode_system_code(sc).upper()
            if not validate_machine_id(mid):
                self.sc_status.set_error(f"Decoded value '{mid}' has unexpected format.")
                self.machine_id.set("")
                return
            self.machine_id.set(mid)
            self.sc_status.set_success(f"Decoded successfully")
        except Exception as e:
            self.sc_status.set_error(f"Decode failed: {e}")
            self.machine_id.set("")

    def _get_expiry(self):
        choice = self.duration_var.get()
        today  = datetime.now()
        if choice == "365":
            return (today + timedelta(days=365)).strftime("%Y-%m-%d"), None
        elif choice == "180":
            return (today + timedelta(days=180)).strftime("%Y-%m-%d"), None
        elif choice == "90":
            return (today + timedelta(days=90)).strftime("%Y-%m-%d"), None
        else:
            raw = self.custom_entry.get().strip()
            if not raw:
                return None, "Please enter a custom expiry date."
            try:
                dt = datetime.strptime(raw, "%Y-%m-%d")
                if dt <= today:
                    return None, "Expiry date must be in the future."
                return raw, None
            except ValueError:
                return None, "Invalid date format. Use YYYY-MM-DD."

    def _generate(self):
        self.gen_status.clear()
        mid = self.machine_id.get()
        if not mid:
            self.gen_status.set_error("Decode a System Code first (Step 01).")
            return
        expiry, err = self._get_expiry()
        if err:
            self.dur_status.set_error(err)
            return
        self.dur_status.clear()
        try:
            features = 0
            for bit, var in self.feature_vars.items():
                if var.get():
                    features |= bit
            key = generate_key(mid, expiry, features)
            self.key_text.config(state="normal")
            self.key_text.delete("1.0", "end")
            self.key_text.insert("end", key)
            self.key_text.config(state="disabled")
            days = (datetime.strptime(expiry, "%Y-%m-%d") - datetime.now()).days
            tier_note = "full access" if features in (ALL_FEATURES, _FULL_FEATURE_MASK) else f"restricted ({bin(features)})"
            self.gen_status.set_success(f"Valid until {expiry}  ({days} days) · {tier_note}")
            self._expiry_for_save = expiry
            self._key_for_save    = key
            self.save_btn.config(state="normal", fg=TEXT)
            # Scroll to bottom so key is visible
            self.canvas.after(50, lambda: self.canvas.yview_moveto(1.0))
        except Exception as e:
            self.gen_status.set_error(f"Generation failed: {e}")

    def _copy_key(self):
        self.key_text.config(state="normal")
        key = self.key_text.get("1.0", "end").strip()
        self.key_text.config(state="disabled")
        if not key:
            return
        self.clipboard_clear()
        self.clipboard_append(key)
        messagebox.showinfo("Copied", "License key copied to clipboard.", parent=self)

    def _save(self):
        mid    = self.machine_id.get()
        expiry = self._expiry_for_save
        key    = self._key_for_save
        if not all([mid, expiry, key]):
            return
        features = 0
        for bit, var in self.feature_vars.items():
            if var.get():
                features |= bit
        if features in (ALL_FEATURES, _FULL_FEATURE_MASK):
            feature_line = "Full access (all features)"
        else:
            enabled = [label for label, bit in FEATURE_CHOICES if features & bit]
            feature_line = ", ".join(enabled) if enabled else "None (base tier only)"
        filename = f"license_{mid.replace('-','')}_{expiry}.txt"
        with open(filename, 'w') as f:
            f.write("LabSoft License Record\n")
            f.write("=" * 50 + "\n")
            f.write(f"Machine ID   : {mid}\n")
            f.write(f"Expiry Date  : {expiry}\n")
            f.write(f"Features     : {feature_line}\n")
            f.write(f"Generated At : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write("=" * 50 + "\n")
            f.write(f"Activation Key:\n{key}\n")
        messagebox.showinfo("Saved", f"Record saved to:\n{filename}", parent=self)


if __name__ == "__main__":
    app = KeygenApp()
    app.mainloop()
