"""Simple Vietnamese GUI for pairing and adding Telegram Reader accounts."""
import asyncio
import platform
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

import requests
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from reader_manager_agent import APP_VERSION, DEFAULT_CLONER_URL, api, start_background
from reader_manager_storage import load_config, save_config


class ReaderManagerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Yêu Nấu Ăn Reader")
        self.geometry("720x520")
        self.minsize(650, 450)
        self.stop_event = None
        self.status_text = tk.StringVar(value="Chưa kết nối")
        self._build()
        self.refresh()
        self.after(500, self.ensure_agent)

    def _build(self):
        outer = ttk.Frame(self, padding=22)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Yêu Nấu Ăn Reader", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        ttk.Label(outer, text="Kết nối tài khoản Telegram phụ với hệ thống V4 mà không cần chạy lệnh.").pack(anchor="w", pady=(2, 16))
        pair = ttk.LabelFrame(outer, text="Kết nối máy Reader", padding=12)
        pair.pack(fill="x")
        self.pairing = ttk.Entry(pair, font=("Segoe UI", 13))
        self.pairing.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.pair_button = ttk.Button(pair, text="Kết nối", command=self.pair_machine)
        self.pair_button.pack(side="right")
        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=14)
        self.add_button = ttk.Button(actions, text="+ Thêm tài khoản Telegram", command=self.add_profile)
        self.add_button.pack(side="left")
        ttk.Button(actions, text="Làm mới", command=self.refresh).pack(side="left", padx=8)
        ttk.Button(actions, text="Xóa tài khoản khỏi máy", command=self.remove_profile).pack(side="left")
        self.tree = ttk.Treeview(outer, columns=("name", "phone", "status"), show="headings", height=12)
        self.tree.heading("name", text="Tài khoản Reader")
        self.tree.heading("phone", text="Telegram")
        self.tree.heading("status", text="Trạng thái")
        self.tree.column("name", width=240)
        self.tree.column("phone", width=160)
        self.tree.column("status", width=190)
        self.tree.pack(fill="both", expand=True)
        ttk.Label(outer, textvariable=self.status_text, foreground="#357a38").pack(anchor="w", pady=(12, 0))

    def config_value(self):
        try:
            return load_config()
        except Exception as exc:
            messagebox.showerror("Không đọc được cấu hình", str(exc))
            return {"version": 1, "profiles": []}

    def refresh(self):
        config = self.config_value()
        paired = bool(config.get("agent_token"))
        self.pairing.configure(state="disabled" if paired else "normal")
        self.pair_button.configure(state="disabled" if paired else "normal")
        self.add_button.configure(state="normal" if paired else "disabled")
        for item in self.tree.get_children():
            self.tree.delete(item)
        labels = {"ready": "Sẵn sàng", "busy": "Đang nhập", "cooldown": "Đang nghỉ", "reauth": "Cần đăng nhập lại", "paused": "Tạm dừng"}
        for profile in config.get("profiles", []):
            self.tree.insert("", "end", iid=profile.get("id"), values=(profile.get("display_name"), profile.get("masked_phone", ""), labels.get(profile.get("status"), profile.get("status", "Sẵn sàng"))))
        self.status_text.set("Đã ghép với V4 Admin · Reader Agent đang hoạt động" if paired else "Nhập mã ghép nối lấy từ V4 Admin")

    def pair_machine(self):
        code = self.pairing.get().strip()
        if not code:
            messagebox.showwarning("Thiếu mã", "Hãy nhập mã ghép nối từ V4 Admin.")
            return
        try:
            response = requests.post(
                DEFAULT_CLONER_URL + "/api/reader/complete?action=pair",
                json={"code": code, "platform": f"Windows {platform.release()}", "app_version": APP_VERSION},
                timeout=30,
            )
            data = response.json()
            if not response.ok:
                raise RuntimeError(data.get("error") or f"HTTP {response.status_code}")
            config = self.config_value()
            config.update({
                "version": 1,
                "cloner_url": DEFAULT_CLONER_URL,
                "agent": data["agent"],
                "agent_token": data["agent_token"],
                "telegram_api_id": str(data["telegram_api_id"]),
                "telegram_api_hash": data["telegram_api_hash"],
            })
            save_config(config)
            messagebox.showinfo("Đã kết nối", "Máy Reader đã kết nối thành công với V4 Admin.")
            self.refresh()
            self.ensure_agent()
        except Exception as exc:
            messagebox.showerror("Không kết nối được", self.friendly_error(exc))

    async def authorize(self, config, phone):
        client = TelegramClient(StringSession(), int(config["telegram_api_id"]), config["telegram_api_hash"])
        await client.connect()
        try:
            sent = await client.send_code_request(phone)
            code = simpledialog.askstring("Mã Telegram", "Nhập mã Telegram vừa gửi cho tài khoản này:", parent=self)
            if not code:
                raise RuntimeError("Bạn chưa nhập mã Telegram")
            try:
                await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
            except SessionPasswordNeededError:
                password = simpledialog.askstring("Mật khẩu hai lớp", "Nhập mật khẩu xác minh hai bước:", show="●", parent=self)
                if not password:
                    raise RuntimeError("Bạn chưa nhập mật khẩu hai lớp")
                await client.sign_in(password=password)
            me = await client.get_me()
            return str(me.id), StringSession.save(client.session)
        finally:
            await client.disconnect()

    def add_profile(self):
        config = self.config_value()
        phone = simpledialog.askstring("Thêm tài khoản Telegram", "Nhập số điện thoại, ví dụ +84912345678:", parent=self)
        if not phone:
            return
        try:
            telegram_id, session = asyncio.run(self.authorize(config, phone.strip()))
            default_name = f"Reader {len(config.get('profiles', [])) + 1:02d}"
            name = simpledialog.askstring("Tên Reader", "Đặt tên dễ nhớ:", initialvalue=default_name, parent=self) or default_name
            masked = f"*******{''.join(ch for ch in phone if ch.isdigit())[-4:]}"
            registered = api(config, "register-profile", {
                "telegram_user_id": telegram_id,
                "display_name": name,
                "masked_phone": masked,
            })["profile"]
            config["profiles"] = [item for item in config.get("profiles", []) if item.get("telegram_user_id") != telegram_id]
            config["profiles"].append({
                "id": registered["id"],
                "telegram_user_id": telegram_id,
                "display_name": registered["display_name"],
                "masked_phone": masked,
                "status": "ready",
                "api_id": str(config["telegram_api_id"]),
                "api_hash": config["telegram_api_hash"],
                "session": session,
            })
            save_config(config)
            messagebox.showinfo("Hoàn tất", f"{registered['display_name']} đã sẵn sàng nhập nội dung.")
            self.refresh()
        except Exception as exc:
            messagebox.showerror("Không thêm được tài khoản", self.friendly_error(exc))

    def remove_profile(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showwarning("Chưa chọn tài khoản", "Hãy chọn một tài khoản Reader trong danh sách.")
            return
        profile_id = selected[0]
        if not messagebox.askyesno("Xóa tài khoản", "Thu hồi Reader và xóa phiên Telegram đã mã hóa khỏi máy này?"):
            return
        try:
            config = self.config_value()
            api(config, "profile-status", {"profile_id": profile_id, "status": "revoked"})
            config["profiles"] = [item for item in config.get("profiles", []) if item.get("id") != profile_id]
            save_config(config)
            self.refresh()
        except Exception as exc:
            messagebox.showerror("Không xóa được tài khoản", self.friendly_error(exc))

    def ensure_agent(self):
        if self.stop_event or not self.config_value().get("agent_token"):
            return
        self.stop_event, _thread = start_background(lambda value: self.after(0, self.status_text.set, value))

    @staticmethod
    def friendly_error(exc):
        text = str(exc)
        mapping = {
            "pairing_expired": "Mã kết nối đã hết hạn. Hãy tạo mã mới trong V4 Admin.",
            "pairing_invalid_or_used": "Mã không đúng hoặc đã được sử dụng.",
            "PhoneCodeInvalidError": "Mã Telegram không chính xác.",
            "PasswordHashInvalidError": "Mật khẩu xác minh hai bước không chính xác.",
        }
        return next((friendly for code, friendly in mapping.items() if code in text), text)

    def destroy(self):
        if self.stop_event:
            self.stop_event.set()
        super().destroy()


if __name__ == "__main__":
    ReaderManagerApp().mainloop()
