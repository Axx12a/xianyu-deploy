@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set COMPOSE_PROJECT_NAME=xianyu-auto-reply

echo ============================================
echo   闲鱼自动回复管理系统 - 启动
echo ============================================
echo.

rem ---- 检查 Docker 是否在运行 ----
docker info >nul 2>&1
if errorlevel 1 (
    echo [错误] Docker Desktop 没有运行。
    echo        请先打开 Docker Desktop，等它状态变绿后再运行本脚本。
    echo.
    pause
    exit /b 1
)

echo [1/3] 启动服务容器（已启动的会自动跳过）...
docker compose -f docker-compose.deploy.yml up -d
if errorlevel 1 (
    echo.
    echo [错误] 启动失败，请查看上面的输出。
    pause
    exit /b 1
)

echo.
echo [2/3] 等待 Web 服务就绪...
set /a n=0
:wait
set /a n+=1
curl -s -o nul http://localhost:9000/ 2>nul
if not errorlevel 1 goto ready
if %n% geq 40 goto timeout
ping -n 3 127.0.0.1 >nul
goto wait

:ready
echo [3/3] 打开浏览器...
start "" http://localhost:9000
echo.
echo ============================================
echo   启动完成
echo ============================================
echo   地址: http://localhost:9000
echo   账号: admin
echo.
echo   这个窗口可以关掉，服务在后台继续运行。
echo   要停止服务请运行「停止系统.bat」。
echo ============================================
ping -n 6 127.0.0.1 >nul
exit /b 0

:timeout
echo.
echo [提示] 等待了 80 秒仍未就绪，可能是首次启动在初始化数据库。
echo        稍后手动打开 http://localhost:9000 即可。
start "" http://localhost:9000
echo.
pause
exit /b 0
