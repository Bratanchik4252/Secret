"""
Minecraft Binder — F8 overlay, letter-by-letter chat insert (no Enter).

Запуск: python main.py
Требуется: Windows, Python 3.10+, PyQt6, keyboard
"""

from __future__ import annotations

import sys

from PyQt6.QtWidgets import QApplication

from binder.branding import apply_app_icon, apply_window_icon
from binder.config import AppData, load_data, save_data
from binder.editor import EditorWindow
from binder.overlay import HotkeyBridge, OverlayPicker, register_f8_hotkey
from binder.seed import seed_if_empty


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Minecraft Binder")
    apply_app_icon(app)

    state: AppData = seed_if_empty(load_data())
    save_data(state)

    def get_data() -> AppData:
        return state

    def persist(data: AppData) -> None:
        nonlocal state
        state = data
        save_data(state)

    overlay = OverlayPicker(get_data, save_data=persist)
    editor = EditorWindow(get_data, persist, reload_overlay=overlay._refresh_lists)

    bridge = HotkeyBridge()
    bridge.triggered.connect(overlay.toggle_overlay)
    register_f8_hotkey(bridge)

    apply_window_icon(editor)
    apply_window_icon(overlay)
    editor.show()

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
