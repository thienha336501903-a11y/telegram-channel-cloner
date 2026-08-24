# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

root = Path(SPECPATH).parent
analysis = Analysis(
    [str(root / "reader-manager" / "reader_manager_gui.py")],
    pathex=[str(root / "reader-manager"), str(root / "reader-cli")],
    binaries=[],
    datas=[
        (str(root / "reader-cli" / "export_history.py"), "reader-cli"),
        (str(root / "reader-cli" / "reconcile_history.py"), "reader-cli"),
    ],
    hiddenimports=["telethon", "requests", "export_history"],
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="YeuNauAnReader",
    console=False,
    onefile=True,
    uac_admin=False,
)
