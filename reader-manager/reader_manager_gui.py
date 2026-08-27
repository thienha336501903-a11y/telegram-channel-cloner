"""Simple Vietnamese GUI for pairing, Telegram Reader accounts, and local V5 R2 setup."""
import asyncio
import platform
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

import requests
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from reader_manager_agent import APP_VERSION, api, has_v5_r2_config, start_background
from reader_manager_pairing import parse_pairing_package
from reader_manager_storage import load_config, save_config


class ReaderManagerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Yêu Nấu Ăn Reader")
        self.geometry("760x570")
        self.minsize(680, 480)
        self.stop_event = None
        self.status_text = tk.StringVar(value="Chưa kết nối")
        self.r2_status_text = tk.StringVar(value="R2 V5: chưa cấu hình")
        self._build()
        self.refresh()
        self.after(500, self.ensure_agent)

    def _build(self):
        outer = ttk.Frame(self, padding=22)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Yêu Nấu Ăn Reader", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        ttk.Label(outer, text="Kết nối tài khoản Telegram phụ với hệ thống học mà không cần chạy lệnh.").pack(anchor="w", pady=(2, 16))
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
        self.r2_button = ttk.Button(actions, text="Cấu hình R2 V5", command=self.configure_r2)
        self.r2_button.pack(side="right")
        self.tree = ttk.Treeview(outer, columns=("name", "phone", "status"), show="headings", height=12)
        self.tree.heading("name", text="Tài khoản Reader")
        self.tree.heading("phone", text="Telegram")
        self.tree.heading("status", text="Trạng thái")
        self.tree.column("name", width=240)
        self.tree.column("phone", width=160)
        self.tree.column("status", width=190)
        self.tree.pack(fill="both", expand=True)
        status_row = ttk.Frame(outer)
        status_row.pack(fill="x", pady=(12, 0))
        ttk.Label(status_row, textvariable=self.status_text, foreground="#357a38").pack(side="left", anchor="w")
        ttk.Label(status_row, textvariable=self.r2_status_text).pack(side="right", anchor="e")

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
        self.r2_button.configure(state="normal" if paired else "disabled")
        for item in self.tree.get_children():
            self.tree.delete(item)
        labels = {"ready": "Sẵn sàng", "busy": "Đang nhập", "cooldown": "Đang nghỉ", "reauth": "Cần đăng nhập lại", "paused": "Tạm dừng"}
        for profile in config.get("profiles", []):
            self.tree.insert("", "end", iid=profile.get("id"), values=(profile.get("display_name"), profile.get("masked_phone", ""), labels.get(profile.get("status"), profile.get("status", "Sẵn sàng"))))
        self.status_text.set("Đã ghép với hệ thống · Reader Agent đang hoạt động" if paired else "Nhập mã ghép nối lấy từ Admin")
        self.r2_status_text.set("R2 V5: sẵn sàng" if has_v5_r2_config(config) else "R2 V5: chưa cấu hình")

    def pair_machine(self):
        pairing_value = self.pairing.get().strip()
        if not pairing_value:
            messagebox.showwarning("Thiếu mã", "Hãy nhập mã ghép nối từ Admin.")
            return
        try:
            cloner_url, code = parse_pairing_package(pairing_value)
            response = requests.post(
                cloner_url + "/api/reader/complete?action=pair",
                json={"code": code, "platform": f"Windows {platform.release()}", "app_version": APP_VERSION},
                timeout=30,
            )
            data = response.json()
            if not response.ok:
                raise RuntimeError(data.get("error") or f"HTTP {response.status_code}")
            config = self.config_value()
            config.update({
                "version": 1,
                "cloner_url": cloner_url,
                "agent": data["agent"],
                "agent_token": data["agent_token"],
                "telegram_api_id": str(data["telegram_api_id"]),
                "telegram_api_hash": data["telegram_api_hash"],
            })
            save_config(config)
            messagebox.showinfo("Đã kết nối", "Máy Reader đã kết nối thành công.")
            self.refresh()
            self.ensure_agent()
        except Exception as exc:
            messagebox.showerror("Không kết nối được", self.friendly_error(exc))

    def configure_r2(self):
        config = self.config_value()
        if not config.get("agent_token"):
            messagebox.showwarning("Chưa kết nối", "Hãy kết nối máy Reader trước.")
            return
        current = config.get("r2") if isinstance(config.get("r2"), dict) else {}
        account_id = simpledialog.askstring("Cloudflare R2", "Account ID:", initialvalue=current.get("account_id", ""), parent=self)
        if account_id is None:
            return
        access_key_id = simpledialog.askstring("Cloudflare R2", "Access Key ID:", initialvalue=current.get("access_key_id", ""), parent=self)
        if access_key_id is None:
            return
        secret = simpledialog.askstring(
            "Cloudflare R2",
            "Secret Access Key (để trống để giữ secret hiện tại):",
            show="●",
            parent=self,
        )
        if secret is None:
            return
        bucket = simpledialog.askstring("Cloudflare R2", "Tên bucket V5:", initialvalue=current.get("bucket", ""), parent=self)
        if bucket is None:
            return
        secret_value = secret.strip() or str(current.get("secret_access_key") or "").strip()
        values = {
            "account_id": account_id.strip(),
            "access_key_id": access_key_id.strip(),
            "secret_access_key": secret_value,
            "bucket": bucket.strip(),
        }
        if not all(values.values()):
            messagebox.showwarning("Thiếu thông tin", "Cần đủ Account ID, Access Key ID, Secret Access Key và tên bucket.")
            return
        config["r2"] = values
        save_config(config)
        self.refresh()
        messagebox.showinfo("Đã lưu", "Cấu hình R2 V5 đã được mã hóa bằng Windows DPAPI và chỉ lưu trên máy Reader này.")

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
            "pairing_expired": "Mã kết nối đã hết hạn. Hãy tạo mã mới trong Admin.",
            "pairing_invalid_or_used": "Mã không đúng hoặc đã được sử dụng.",
            "pairing_package_invalid": "Mã kết nối không đúng định dạng. Hãy sao chép lại toàn bộ mã từ Admin.",
            "reader_server_not_trusted": "Mã kết nối không thuộc máy chủ được tin cậy.",
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
