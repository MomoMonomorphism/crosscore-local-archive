"""Write the bounded source audit and adoption evidence into repository docs."""
import csv
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_paths import PATHS
from tools.audit_spine_platforms import OUTPUT


def main():
    audit = json.loads(OUTPUT.read_text('utf8'))
    registry = json.loads((ROOT / 'spine_resource_references.json').read_text('utf8'))
    manifest = json.loads((PATHS['cache'] / 'assets.generated.json').read_text('utf8'))
    labels = {e['id']: e.get('displayName') or e['title'] for e in manifest['entries']}
    holds = json.loads((ROOT / '.scratch/spine-android-batch/runtime-holds.json').read_text('utf8'))['packages']
    rows = []
    for package, row in audit['packages'].items():
        names = '、'.join(sorted({labels[ref['entry']] for ref in row['references'] if 'entry' in ref}))
        changes = '；'.join(m['model'] + ':' + ','.join(m['sections'] + m['actions']) for m in row.get('modelsChanged', []))
        rows.append({'package': package, 'characters': names, 'status': 'runtime-held' if package in holds else row['status'],
                     'selected': 'android-cn' if package in registry else 'pc-tw',
                     'entranceChanged': any(m['entranceChanged'] for m in row.get('modelsChanged', [])),
                     'reasons': ','.join(row.get('reasons', [])), 'changes': changes,
                     'lowerResolution': ','.join(row.get('lowerResolutionTextures', [])),
                     'sourceGap': holds.get(package, {}).get('reason') or row.get('error', ''),
                     'pcSha256': row.get('pcSha256', ''), 'androidSha256': row.get('androidSha256', '')})
    target = ROOT / 'docs/SPINE_PLATFORM_AUDIT_2026-10-01.csv'
    with target.open('w', newline='', encoding='utf-8-sig') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)
    adoption = json.loads((ROOT / '.scratch/spine-android-batch/adoption.json').read_text('utf8'))
    runtime = json.loads((ROOT / '.scratch/spine-android-batch/runtime-check.json').read_text('utf8'))
    hall = json.loads((ROOT / '.scratch/spine-android-batch/hall-runtime-check.json').read_text('utf8'))
    statuses = {'compatible': '兼容且安卓贴图不降分辨率', 'compatible-lower-resolution': '兼容但安卓贴图更低',
                'review': '骨骼／动作／图集等有差异', 'missing-android': '快照缺对应安卓包', 'unresolved': '原包无法直接比较',
                'runtime-held': '两端运行时采样异常，暂缓'}
    text = ['# 角色资源安卓／PC批量核对（2026-10-01）', '',
            '范围为当前176个角色、431套展示形态及其主体、附加特效和姿态配置引用，共422个唯一包。只读检查固定快照，不读取更新中的游戏目录，也不需要连接MuMu。', '',
            '| 分类 | 包数 | 处理 |', '| --- | ---: | --- |']
    for status, label in statuses.items():
        count = len(holds) if status == 'runtime-held' else audit['summary'].get(status, 0) - (len(holds) if status == 'compatible' else 0)
        text.append(f'| {label} | {count} | ' + ('验证后接入安卓原包 |' if status == 'compatible' else '保留现有来源，列入清单 |'))
    text += ['', f'新增{adoption["newReferences"]}个固定安卓来源，登记总数{adoption["totalReferences"]}；包括此前专项验收接入的冕羽03。阿尔卑斯03包含在兼容组。19个差异包中的冕羽03保留此前单独接入结果，其余未自动切换。', '',
             '## 自动接入的条件', '',
             '比较同名原包所有骨骼的完整非头部数据（骨骼、槽、皮肤、附件、约束、事件及全部动作时间轴），并检查声明边界、atlas、原生默认待机和混合参数、布局、材质与网格生成参数。骨骼必须保持4.2运行时系列。允许导出hash／补丁版本、贴图压缩编码差异；不自动降低任何图集页的分辨率。任一播放数据、身份或原生参数不一致均退出自动接入。', '',
             '原JSON及材质不被修补：隔离提取完整安卓包，逐项核对骨骼内容哈希、atlas字节、PNG完整性／尺寸及原生参数。原包的名称尾部空格统一按现有提取规则去除，并拒绝归一化后重名；修正Leader03原生参数索引，缓存参数格式升级为3。', '',
             '## 有差异、缺包或暂缓的条目', '',
             '| 角色 | 原包 | 分类 | 入场数据变化 |', '| --- | --- | --- | --- |']
    for row in rows:
        if row['status'] == 'compatible': continue
        text.append(f'| {row["characters"] or "辅助素材"} | `{row["package"].removeprefix("prefabs_spine_")}` | {statuses.get(row["status"], row["status"])} | {"是" if row["entranceChanged"] else "未确认" if row["status"] in ("unresolved", "missing-android") else "否"} |')
    text += ['', '全量包名、受影响角色、具体变化的动作／骨骼部分、选定来源及两端SHA256见 [CSV清单](SPINE_PLATFORM_AUDIT_2026-10-01.csv)。有数据差异不等于游戏出错；尚未逐项对照安卓实际画面。', '',
             '3个无法直接比较的包：安卓Sphalerite突破与Durandal04包无内嵌TextAsset骨骼／图集，不能用当前提取路径代替网页资源；Feast包含多个同名骨骼，不能按名字猜测配对。8个缺包只表示本固定安卓快照没有这些文件，不代表游戏内没有相应皮肤。', '',
             '哈托莉05（Salticidae05）的原始失败已定位：click9／click10把role1分层缩为零，变换约束反解不可逆矩阵，再由IK传播到1_arm_R。生产网页增加严格限于父子世界矩阵均完全为零的数值保护，保留当前帧有效局部变换，不修改原骨骼数据。两端13个动作及原生轨道0待机切换、保留轨道8、互动与恢复均通过；原本有限的网格坐标逐项保持一致。此包现接入安卓。最初失败报告runtime-check-initial.json及暂缓记录runtime-holds-before-hattori.json保留；详见HATTORI05_CONSTRAINT_REVIEW_2026-10-01.md。游戏实机视觉仍需验收，不据此认定原游戏也有错误。', '',
             '## 验证结果与边界', '',
             f'- 386个候选包的隔离提取、原骨骼／图集一致性、PNG解码与原生参数校验通过。',
             f'- {len(runtime["results"])}个主体／特效模型使用生产spine-core解析，全部{sum(r["actions"] for r in runtime["results"])}个动作在开始／中点／结束采样，骨骼坐标与网格顶点均为有限值。',
             f'- 259条配置入场验证：{sum(r["status"] == "passed" for r in hall["results"])}条完整播放及转场通过，{sum(r["status"] == "idle-fallback" for r in hall["results"])}条原缺in配置正确回退。其中{runtime["replacedEntrances"]}条使用隔离安卓数据。',
             '- 来源与分类单元测试、TypeScript检查和本地构建通过；实际浏览器／MuMu像素、声音和交互视觉验收由用户完成。运行时采样不代表100%原生渲染一致。', '',
             '- 本地8798服务的首批HTTP抽查包括霸王龙04、巴德兰兹05A、Leader03、阿尔卑斯03及冕羽03，证据保存于live-verification.json。哈托莉05后续验证另存hattori-live-verification.json；来源切换须重新构建并重启服务。', '',
             '## 运行与回退', '',
             '`spine_resource_references.json`记录每个来源、两端SHA256和适用PC快照根。仅在已核对的固定PC根上启用替代；其他电脑配置自己的游戏根或显式替代来源时保留其原资源。启动预检核对活动来源及哈希。源文件修改会报错，不静默回退。原PC／安卓快照保持只读。', '',
             '正式缓存仍按需提取；已加载的其他包不会被批量删除或重建。前端构建直接读取登记表生成整组骨骼／图集／贴图的缓存版本，避免手工维护列表或混入旧PC贴图。生成的前端映射只含包名和来源hash摘要，不包含本机路径。', '',
             'Pages下次打包沿用登记的原资源选择。当前演示角色范围和在线站点未更新，本轮没有发布或提交。', '',
             '隔离证据：`.scratch/spine-platform-audit.json`、`.scratch/spine-android-batch/prepared.json`、`runtime-check.json`、`hall-runtime-check.json`及`adoption.json`。切换前登记备份为同目录`registry-before.json`；需要撤回时恢复登记表、重新构建前端并重启服务，资源缓存随后按原来源重新提取。不要修改原游戏快照。', '',
             '## 复跑', '', '```powershell',
             '& $viewerPython -X utf8 tools/audit_spine_platforms.py',
             '& $viewerPython -X utf8 tools/prepare_spine_references.py',
             'Set-Location web', 'node --experimental-strip-types check-platform-assets.ts',
             'node --experimental-strip-types check-hall-assets.ts ../.scratch/spine-android-batch/hall-audit.json ../.scratch/spine-android-batch/hall-runtime-check.json',
             'Set-Location ..', '& $viewerPython -X utf8 tools/apply_spine_references.py # 只核对计划',
             '& $viewerPython -X utf8 tools/apply_spine_references.py --apply # 明确更新来源登记',
             '& $viewerPython -X utf8 tools/report_spine_platforms.py', '```', '']
    (ROOT / 'docs/SPINE_PLATFORM_AUDIT_2026-10-01.md').write_text('\n'.join(text), 'utf8')
    print(json.dumps({'csvRows': len(rows), **adoption}, ensure_ascii=False))


if __name__ == '__main__': main()
