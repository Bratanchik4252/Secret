@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/4] Зависимости...
python -m pip install -r requirements.txt -q
python -m pip install pyinstaller pillow -q

echo [2/4] Иконка .ico из mascot.png...
python scripts\make_icon.py
if errorlevel 1 exit /b 1

echo [3/4] Сборка MinecraftBinder.exe...
python -m PyInstaller binder.spec --noconfirm
if errorlevel 1 exit /b 1

echo [4/4] Готово!
echo.
echo   EXE: dist\MinecraftBinder.exe
echo   Положи binder_data.json рядом с exe — настройки сохраняются там.
echo.
pause
