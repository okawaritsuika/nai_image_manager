@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ========================================
echo NAI Image Manager Update
echo ========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or not available in PATH.
    echo Download Git: https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [ERROR] This folder is not a Git clone.
    echo Please clone the repository first:
    echo git clone https://github.com/okawaritsuika/nai_image_manager.git
    echo.
    pause
    exit /b 1
)

echo Fetching latest master from GitHub...
git fetch origin master
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to fetch from origin/master.
    pause
    exit /b 1
)

echo.
echo Updating local files...
git pull --ff-only origin master
if errorlevel 1 (
    echo.
    echo [ERROR] Update failed.
    echo Local changes may be blocking the update.
    echo Commit, stash, or remove local code changes, then run update.bat again.
    echo Personal settings and generated files ignored by Git are not affected.
    pause
    exit /b 1
)

echo.
echo Update complete.
echo.
pause
