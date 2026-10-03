# 交错战线 · 本地动态立绘与交互预览

这是玩家制作的**非官方预览项目**，与游戏开发商、发行商无关。可在浏览器中查看精选角色立绘、CG、插画、台词及互动小游戏。

**在线演示：** [打开 GitHub Pages](https://momomonomorphism.github.io/crosscore-local-archive/)。Pages 版将演示资源和交互脚本下载到浏览器，游玩过程中无需连接本项目的后端；首次加载需要下载相应素材，移动网络请留意流量。

## 本地版

仓库包含本地版源码，但不包含完整游戏包。需要使用者自行准备可用的游戏资源、Windows x64、Python 和 Node.js。现有作者机器上的缓存曾通过验收；全新机器的空缓存安装尚未完整验证，遇到启动问题请参阅 [运行手册](docs/RUNBOOK.md)。

```powershell
Set-Location <仓库目录>
python -m pip install -r requirements.txt
Set-Location web
npm ci
Set-Location ..
.\start_viewer.ps1 -Port 8798 -Build
```

复制并填写 `viewer.example.json` 中的资源路径。

## Pages 演示版

仓库中的 `pages-pack/public/` 只包含演示选定的资源，由 `tools/prepare_pages_demo.py` 从本地资源生成：6 个角色入口（默认立绘、动态骨骼、交互与素材预览）、4 组 CG / 插画档案、1 段 ASMR 预览（前 18 秒），以及 5 套在浏览器内运行的小游戏。`.github/workflows/pages.yml` 通过 GitHub Actions 构建并部署静态网站（推送到 `main` 时自动触发，也可手动触发），构建基址取自仓库名。仓库首页的源码与 Pages 网站是同一项目的本地版和静态预览版。

## 开发者模式

本地版和在线演示均可点击左上角 **CC** 切换开发者模式，再通过顶部的“开发工具”打开点选检查器和图层磁贴。支持查看资源缩略图、点选与定位图层、显隐、透明度、独显、遮罩控制及命名预设；切回普通模式会恢复临时调整。详见 [使用说明](docs/DEVELOPER_MODE.md)。

## 许可与资源

项目原创代码按 [MIT](LICENSE) 发布。第三方游戏资源、原游戏脚本、文本及 Spine 等运行库按各自权利和许可使用，不适用本项目的 MIT 授权。详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 Pages 包中的 `licenses/`。
