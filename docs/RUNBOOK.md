# 本地运行与资源准备

更新：2026-10-13。仓库提供本地版正式源码和精选 Pages 演示资源。完整游戏包与完整运行缓存需自行准备；全新电脑的空缓存重建尚未完整验证。

## 安装与启动

本地完整交互需要 Windows x64、Python 3.13、Node.js 24、自备游戏资源、原生 xLua DLL 和音频解码器。

```powershell
python -m pip install -r requirements.txt
Copy-Item viewer.example.json viewer.local.json
# 编辑 viewer.local.json，配置自己的资源和已准备的缓存。
cd web
npm ci
cd ..
.\start_viewer.ps1 -Build -CheckOnly -NoBrowser
.\start_viewer.ps1 -Port 8798 -NoBrowser
```

去掉 `-NoBrowser` 打开默认浏览器。`-CheckOnly` 检查依赖与输入，不生成缓存；与 `-Build` 合用仍执行明确要求的前端构建。启动器不会删除或自动重建验收清单。

可用 `-Python` 指定解释器、`-Config` 指定外部配置。修改前端后重新构建并刷新；修改后端或启动时载入的清单后，需要重启对应服务。

## 路径配置

JSON 相对路径以配置文件目录为基准。优先级为 `CROSSCORE_<大写键名>` 环境变量、JSON 配置、默认值；`CROSSCORE_CONFIG` 可指定配置文件。未知键会报错。

| 键 | 用途 |
|---|---|
| game_data | PC 客户端数据目录，用于推导其余路径 |
| source | 资源包目录，通常是 `GameHotRes/Custom` |
| lua_bundle | Lua 数据包，通常是 source 下的 `luascripts` |
| voice_source / chinese_source | 日配与可选中配音频目录 |
| xlua | Windows x64 原生 xLua DLL |
| cache | 当前资源集专用运行缓存 |
| census | 已核实的资源普查 JSON |
| decoder | 音频解码器及其运行依赖 |

小游戏还使用日配目录同级的 `temp/temp.acb` 和 `bgms/LycorisRadiata_Music_01.acb`。不同资源集应使用独立缓存。`/api/health` 返回工作目录、路径、进程与前端哈希，启动器据此核对服务身份。

## 运行清单

预检需要六项缓存清单：`assets.generated.json`、`voices.generated.json`、`asmr.generated.json`、`spine_action.generated.json`、`multi_picture_action.generated.json`、`thumbnails.generated.json`。

依赖顺序为资源普查与资产索引、语音与 ASMR 及交互配置、多人插画配置、缩略图。生成入口分别为 `generate_manifest.py`、`voice_cache.py`、`spine_action.py`、`multi_picture_action.py`、`thumbnail_cache.py`。这些入口不替代缺失的历史保留输入；不要用空缓存重建覆盖唯一的已验收清单。仓库没有完整的一键资源普查和冷启动准备流程。

## 安卓简体文本与语音

从自己的固定安卓 Lua 包生成显示文字覆盖表：

```powershell
python tools/build_android_text.py --android '<安卓 luascripts 路径>'
python tools/refresh_voice_index.py
# 检查输出后，需要写入当前语音清单时使用 --apply。
```

简体覆盖保存到配置缓存中的 `android_text_zh_cn.generated.json`。缺少覆盖表时服务器保留原文本；覆盖不改变资源 ID、音轨或动作。语音修复工具通过来源指纹核对已有音轨及文本元数据。

## 固定资源与缓存

`spine_resource_references.json` 保存已验证包的相对目录、基准与替代包指纹。只有配置来源与已审计基准相符时才使用指定替代包；其他资源来源保持自身内容。适用的指定包缺失或指纹不符时会报错。前端仅使用版本标记，Pages 独立使用 `pages-pack/spine-references.json`。

`tools/freeze_resource_baseline.py --destination '<新目录>'` 可复制并验证当前本地资源基线；`tools/freeze_android_baseline.py` 可通过明确指定的 adb、设备和新目录导出已关闭游戏的安卓资源。`tools/verify_resource_baseline.py '<快照目录>'` 只读验证快照。导出工具不会用于日常启动。

## 验证与 Pages

构建本地前端后，`python tools/check_startup.py` 使用临时缓存和临时端口检查配置、源码导入及服务身份。独立测试的命令见 `.github/workflows/local-source-check.yml`，不需要完整游戏包。

Pages 构建使用仓库内的精选资源：在 web 目录运行 `npm run build:pages`，部署时设置仓库名对应的 `VITE_BASE_PATH`。完整演示包重建工具 `tools/prepare_pages_demo.py` 需要本地已准备资源；仅调整共用小游戏 host 时可使用 `tools/refresh_offline_ui_host.py --directory pages-pack/public/offline/ui`，保留各程序的资源与游戏源码前缀。

同步范围与本地保留内容见 [同步清单](SYNC_STATUS.md)，开发者工具见 [开发者模式](DEVELOPER_MODE.md)。
