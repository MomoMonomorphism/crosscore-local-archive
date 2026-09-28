# 当前主线运行手册

更新：2026-09-28。生产入口已支持统一路径配置、只读预检和服务身份核对。本机检查通过；还没有在全新电脑做完整安装或空缓存重建。

## 日常启动

在项目目录运行：

```powershell
.\start_viewer.ps1 -CheckOnly -NoBrowser
.\start_viewer.ps1 -NoBrowser
```

第一条只检查依赖与输入，不启动服务、不生成缓存。第二条启动或复用经核实的本项目服务；去掉 `-NoBrowser` 打开默认浏览器。默认地址为 http://127.0.0.1:8798/ 。

修改前端后：

```powershell
.\start_viewer.ps1 -Build -CheckOnly -NoBrowser
```

先执行 TypeScript 检查，再构建 dist，保留独立设计/材质检查页。已有页面需要刷新。`-Build` 与 `-CheckOnly` 同用时仍会执行明确要求的构建；只有不带 `-Build` 的预检是只读的。

启动器不会自动删除或重建任何缺失清单；缺失或结构损坏会列出具体文件，停止启动。已有历史补充数据不能用一次自动重建代替。

## Python 与前端依赖

Python 的选择顺序：`-Python` 参数 → `CROSSCORE_PYTHON` → 项目 `.venv/Scripts/python.exe` → PATH → 原本机 crosscore 环境。显式参数路径无效时报错。

```powershell
.\start_viewer.ps1 -Python 'D:/venvs/crosscore/Scripts/python.exe' -CheckOnly
```

需要 Windows x64 Python；依赖见 requirements.txt。本机验证版本为 Python 3.13.14、UnityPy 1.25.3、Pillow 12.3.0、brotli 1.2.0、lz4 4.4.5、texture2ddecoder 1.0.6。原 xLua 是 Windows DLL。

前端构建需要 PATH 中的 Node，本机为 24.19.0。新目录先在 web 内按锁文件运行 `npm ci`。启动器不会自动安装包。目前本机 web/node_modules 仍是指向旧 local_viewer 工作树的 Junction，不能随文件夹复制视作独立依赖。

## 统一资源路径

复制 viewer.example.json 为 viewer.local.json，按需要修改；本地配置不纳入 Git。也可指定外部配置：

```powershell
.\start_viewer.ps1 -Config 'D:/CrossCore/viewer.json' -CheckOnly
```

相对路径以配置文件所在目录为基准。各项优先级为 `CROSSCORE_<大写键名>` 环境变量 → JSON 配置 → 默认值。配置文件可通过 `CROSSCORE_CONFIG` 指定。未知键会报错，避免拼写错误悄悄失效。

| 配置键 | 默认位置 / 推导 |
|---|---|
| game_data | `../Daibloscore/client/DAIBLOSCORE_Data` |
| source | game_data 下 `GameHotRes/Custom` |
| lua_bundle | source 下 `luascripts` |
| voice_source | source 同级 `sounds/cv` |
| chinese_source | voice_source 向上两层下 `sounds_cn/cv` |
| xlua | game_data 下 `Plugins/x86_64/xlua.dll` |
| cache | 项目 `cache` |
| census | `../.probe/census_full.json` |
| decoder | `../tools/vgmstream/vgmstream-cli.exe` |

五套小游戏还需要 voice_source 同级的 temp/temp.acb 和 bgms/LycorisRadiata_Music_01.acb；解码器运行依赖须与 exe 一起保留。中配目录为可选项。

统一配置覆盖服务器、资产缓存、Lua 包、xLua、语音、主要交互和缩略图生成器。历史逆向探针可能仍含本机路径。旧 server.py 的 `--source` / `--cache` 等只覆盖对应服务器参数，不会重新绑定已导入模块的全部默认参数；整套迁移应使用上述 JSON / 环境变量。

## 服务身份与升级

`/api/health` 返回 service、workspace、pid、parentPid、runtimePaths 和 dist/index.html 的 SHA256。启动器核对工作树和所有配置路径；Windows 虚拟环境启动器创建子进程时也能识别。

8798 上原先已经运行的旧后端不会因文件修改自动升级。本轮没有停止它。新启动器遇到没有身份字段的旧实例会明确报错，不会误认或结束它。准备重启时先核对进程与工作目录，再停止该实例；也可用其他端口验证。不要照搬旧报告的 PID。

前台调试示例：

```powershell
$viewerPython = 'C:/Users/Admin/.workbuddy/binaries/python/envs/crosscore/Scripts/python.exe'
& $viewerPython -X utf8 server.py --host 127.0.0.1 --port 8798
```

先确认端口空闲。退出前台用 Ctrl+C。Vite 开发代理默认指向 8798，换后端端口时需要对应修改。

## 数据准备与重建边界

当前六项必要清单：assets、voices、asmr、spine_action、multi_picture_action、thumbnails 的 generated.json。预检校验它们的 JSON 与关键字段类型，也检查 census 的基本结构；这不是全部资源内容一致性验收。

生产数据依赖顺序为：

1. 原资源普查 census → 资产清单。
2. 原 Lua / 音频 → voices 与 ASMR；原交互配置与保留输入 → spine_action。
3. 资产、语音与多人配置 → multi_picture_action。
4. 资产及多人关联 → thumbnails。

此顺序用于规划隔离重建，尚非已验证的一键冷启动流程。仓库目前没有独立 census 生成入口；先恢复本地快照中的 external/census_full.json 或提供已核实索引。普通交互保留旧记录 1007003，语音保留旧语义计数 342；后者不是已证明的冷重建丢失数。完整空缓存重建需先把这些输入整理为可追溯来源，不能直接删除验收缓存。

server 启动时将部分清单载入内存，修改清单后须重启经确认的实例。图像/音频可按需提取；原游戏目录保持只读。Unity Editor 不是当前浏览所需依赖，原生粒子任务仍暂缓。

## 本地版本恢复

- 源码基线：提交 `21500b5`，标签 `viewer-frontend-accepted-2026-09-28`。
- 运行输入：`.local-baselines/viewer-frontend-accepted-2026-09-28/snapshot.json` 与 `runtime-inputs-and-dist.zip`，163 项文件，ZIP 和逐项 SHA256 已核对。
- 后续维护改动另作提交，原前端基线保留。
- 该目录是 Git worktree，Git 历史位于上级 local_viewer/.git；只复制工作目录不包含完整历史。
- 恢复前另存当前改动，在单独目录恢复标签代码并核对快照哈希。压缩包 cache/、dist/ 对应工作树；external/census_full.json 对应配置的 census。
- 快照不含原游戏全部资源、全部图片/音频缓存、Python 和 node_modules，不是独立分发安装包。

## 验证与遗留

```powershell
& $viewerPython -X utf8 tools/check_startup.py
& $viewerPython -X utf8 tools/check_ui_timeline.py
```

启动测试使用临时缓存与临时端口，测试服务自行关闭；不接触 8798 正在使用的实例。浏览器画面、声音与手机验收仍由用户完成。

本轮结果见 [维护复核](MAINTENANCE_REVIEW_2026-09-28.md)，剩余事项见 [已知问题](../KNOWN_ISSUES.md)。9月27日发布审计保留为历史证据；其中固定路径和未纳入版本的问题应以本轮更新为准。
