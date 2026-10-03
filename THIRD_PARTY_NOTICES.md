# 许可与资源边界

根目录的 [MIT 许可证](LICENSE) 仅授予本项目原创代码的使用许可。它不改变游戏素材、原游戏 Lua 脚本、游戏台词、截图、提取或还原的配置数据，以及第三方依赖的权利归属。即使这些内容出现在同一个仓库或静态站点中，也不能据此视为 MIT 内容。

## 游戏资源

Pages 演示包由本地游戏资源生成，包含选定的 Spine 骨骼与纹理、插画、音频、台词、小游戏 Lua 场景及相关数据。

本地版需要使用者自行提供游戏资源。仓库不应上传原游戏完整资源目录、缓存和生成的资源包。

## 第三方运行库

- Spine Runtimes（`@esotericsoftware/spine-pixi-v7`、`@esotericsoftware/spine-core`，4.2.120）：采用 Esoteric Software 的单独许可。发布包随附 [Spine Runtimes 许可原文](third_party/SPINE_RUNTIMES_LICENSE.txt)。该许可对运行库集成和产品再分发有额外条件；公开 Pages 前需要确认符合这些条件。
- PixiJS 7.4.3、React 18.3.1、React DOM 18.3.1、Fengari 0.1.5 等依赖按各自许可证分发；它们不受本项目的 MIT 授权覆盖。构建前从锁文件和安装包生成 `licenses/WEB_DEPENDENCIES.txt`，随静态包保留所用依赖的版权和许可文本。

资源授权和运行库条款核实完成后，在公开仓库及 Pages 站点中保留最终的来源和许可清单。
