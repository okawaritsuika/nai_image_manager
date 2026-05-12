@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "REPO_URL=https://github.com/okawaritsuika/nai_image_manager.git"
set "BRANCH=master"

echo ========================================
echo NAI Image Manager Update
echo ========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or not registered in PATH.
    echo Please install Git first, then run this file again.
    echo.
    pause
    exit /b 1
)

if not exist ".git" goto ZIP_INSTALL

goto GIT_UPDATE


:ZIP_INSTALL
echo [INFO] This folder is not a Git repository.
echo [INFO] This usually means you downloaded the ZIP version.
echo.
echo This updater can convert this folder into a Git-managed folder.
echo Source files may be overwritten with the latest GitHub version.
echo A backup will be created before conversion.
echo User data files should remain if they are ignored by Git.
echo.
set /p CONFIRM=Convert this folder and update now? (Y/N):

if /I not "%CONFIRM%"=="Y" (
    echo.
    echo [CANCELLED] Update cancelled by user.
    echo.
    pause
    exit /b 0
)

call :CREATE_BACKUP
if errorlevel 1 exit /b 1

echo.
echo Initializing Git repository...
git init
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to initialize Git repository.
    echo.
    pause
    exit /b 1
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)

echo.
echo Fetching latest version from GitHub...
git -c fetch.writeCommitGraph=false -c gc.auto=0 -c maintenance.auto=false fetch origin %BRANCH%
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to fetch latest version information.
    echo Please check your internet connection or GitHub access.
    echo.
    pause
    exit /b 1
)

echo.
echo Converting ZIP folder to Git-managed folder...
git symbolic-ref HEAD refs/heads/%BRANCH% >nul 2>nul
git reset --hard origin/%BRANCH%
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to synchronize files with GitHub.
    echo Your backup folder was already created before this step.
    echo.
    pause
    exit /b 1
)

git branch --set-upstream-to=origin/%BRANCH% %BRANCH% >nul 2>nul

echo.
echo [OK] ZIP folder was converted successfully.
echo [OK] Latest version is now installed.
echo.
pause
exit /b 0


:GIT_UPDATE
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)

echo Checking local changes...
git status --porcelain > "%TEMP%\naim_git_status.txt"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to check local Git status.
    echo.
    pause
    exit /b 1
)

for /f "usebackq delims=" %%A in ("%TEMP%\naim_git_status.txt") do (
    del "%TEMP%\naim_git_status.txt" >nul 2>nul
    echo.
    echo [WARNING] Local source files have been modified.
    echo To avoid overwriting your changes, update has been stopped.
    echo Please commit, stash, or back up your changes first.
    echo.
    pause
    exit /b 1
)

del "%TEMP%\naim_git_status.txt" >nul 2>nul

echo Checking latest version...
git -c fetch.writeCommitGraph=false -c gc.auto=0 -c maintenance.auto=false fetch origin %BRANCH%
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to fetch latest version information.
    echo Please check your internet connection or GitHub access.
    echo.
    pause
    exit /b 1
)

echo.
for /f "delims=" %%A in ('git rev-parse HEAD') do set "LOCAL_COMMIT=%%A"
for /f "delims=" %%A in ('git rev-parse origin/%BRANCH%') do set "REMOTE_COMMIT=%%A"

if "%LOCAL_COMMIT%"=="%REMOTE_COMMIT%" (
    echo [OK] Already up to date. No update needed.
    echo.
    pause
    exit /b 0
)

echo Updating to latest version...
git merge --ff-only origin/%BRANCH%
if errorlevel 1 (
    echo.
    echo [ERROR] Update failed.
    echo Local changes, a Git lock, or another Git problem may be blocking the update.
    echo If you modified source files manually, please commit, stash, or back them up first.
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Update complete.
echo.
pause
exit /b 0


:CREATE_BACKUP
for /f "tokens=1-4 delims=/-. " %%A in ("%date%") do set "DATE_PART=%%A%%B%%C%%D"
for /f "tokens=1-4 delims=:., " %%A in ("%time%") do set "TIME_PART=%%A%%B%%C%%D"
set "DATE_PART=%DATE_PART: =0%"
set "TIME_PART=%TIME_PART: =0%"
set "BACKUP_DIR=_update_backup_%DATE_PART%_%TIME_PART%"

echo.
echo Creating backup before conversion...
mkdir "%BACKUP_DIR%"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to create backup folder.
    echo Update was stopped for safety.
    echo.
    pause
    exit /b 1
)

robocopy "." "%BACKUP_DIR%" /E /XD ".git" "%BACKUP_DIR%" ".venv" "__pycache__" /XF "update.bat" >nul
if errorlevel 8 (
    echo.
    echo [ERROR] Failed to create backup.
    echo Update was stopped for safety.
    echo.
    pause
    exit /b 1
)

echo [OK] Backup created: %BACKUP_DIR%
exit /b 0
