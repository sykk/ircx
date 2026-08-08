@echo off
setlocal EnableExtensions

rem Rust needs link.exe *and* msvcrt.lib on LIB. A partial Visual Studio
rem install (linker present, Windows SDK / MSVC libs missing) fails with:
rem   LINK : fatal error LNK1104: cannot open file 'msvcrt.lib'
rem Always bootstrap the MSVC environment before calling cargo.

set "VCVARS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
  set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
)

if not defined VCVARS (
  echo.
  echo   Could not find Visual Studio with the C++ build tools.
  echo   Install "Desktop development with C++" from:
  echo   https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo.
  exit /b 1
)

call "%VCVARS%" || exit /b 1
cd /d "%~dp0.."
npm run tauri -- %*
