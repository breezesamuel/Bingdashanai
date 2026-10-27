#!/bin/bash
# 支付/订阅墙回归测试套件
# 用法：bash tests/run_all.sh        （在仓库根或 tests/ 下执行都可以）
# 退出码 0 = 全通过；1 = 有失败
#
# 【隔离】默认把 BINGDASHAN_DATA_DIR 指到临时目录 → **绝不碰线上/本地真实账本**。
#   早先版本直接在真实 data/db.json 上跑，靠一段「按 visitor 前缀删残留」的清理兜底；
#   但 revenue 从不被清理 → 测试跑一次就留下永久的假收入（那是不允许的）。
#   隔离之后，那段清理彻底不需要了 —— 顺带消除了「误删真实客户记录」的历史风险。
#
# 【可移植】不再硬编码 /opt/bingdashan，路径由脚本自身位置推导 → 本地/CI/线上都能跑。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

export BINGDASHAN_DATA_DIR="${BD_TEST_DATA_DIR:-$(mktemp -d /tmp/bd-regress-XXXXXX)}"
export NODE_ENV=test
echo "测试数据目录（隔离）：$BINGDASHAN_DATA_DIR"

FAILED=0
# 【2026-10-24】纳入两套端到端真调用：付费/订阅墙全链 e2e + 注册表幽灵探针。
# e2e_pay_wall 含 31s 防刷冷却等待（设计行为），套件耗时约 1 分钟属正常。
# 【2026-10-24 二批】regress_renewal（续费/到期/顺延，钱损高危区）+ e2e_fe_wiring（前端 267 端点接线零死链）。
# 【2026-10-24 三批】e2e_care（陪护链路 HTTP 端到端：双身份/SOS/加密档案/CENC1 资料/运营端点鉴权）。
# 【2026-10-24 四批】regress_i18n_audit（三语覆盖门禁：夹生翻译拦在部署前）。
# 【2026-10-24 五批】regress_i18n_pipeline（动态门禁：真实 trSegment 管线跑一遍，
#   拦"配了词条但整句没被命中/单字量词插进词内/zh 模式返回外语"这类静态审计看不见的夹生）。
# 【2026-10-25 六批】regress_capability_map（能力全景扫描器盲区守卫：子页 HTML/动态拼接
#   路径/机器端点三类误报不复发——缺口清单是补入口的决策依据，报假数就全废了）。
# 【2026-10-25 七批】regress_xuanxue（易学预测技能组：紫微 iztro/八字 lunar-javascript/
#   梅花起卦可复算/滴天髓检索——决策预测链路真引擎，锚点 2026=丙午年）。
# 【2026-10-25 八批】regress_hardware（硬件自主管理内核：语义档案零硬编码/热插拔 diff/
#   命令闸门/真机枚举/回环契约）。
for t in regress_prov regress_guard regress_edge regress_notify regress_notify_route regress_email regress_refund regress_refund_ui regress_ops_console regress_zero_touch regress_wiring regress_scale_identity regress_scale_money regress_recover_cross_device regress_receipt_refund regress_invite_antiabuse regress_cost_ledger regress_rebate_guard regress_probe_budget regress_fulfillment_money regress_renewal regress_i18n_audit regress_i18n_pipeline regress_capability_map regress_xuanxue regress_hardware e2e_fe_wiring e2e_care e2e_pay_wall e2e_registry_probe e2e_client_mode; do
  echo "=========================================="
  echo "  $t"
  echo "=========================================="
  if [ ! -f "tests/$t.js" ]; then
    echo "  -> SKIP（文件不存在）"
    continue
  fi
  OUT=$(node "tests/$t.js" 2>&1)
  echo "$OUT" | grep -E "^\s+\[(PASS|FAIL)\]|^===|pass=|ALL PASS|FAILED" | head -60
  if echo "$OUT" | grep -q "ALL PASS"; then
    echo "  -> PASS"
  else
    echo "  -> FAIL"
    FAILED=1
  fi
  echo ""
done

# 隔离目录直接删掉即可，无需在真实账本上做清理
rm -rf "$BINGDASHAN_DATA_DIR" 2>/dev/null

echo "=========================================="
if [ "$FAILED" = "0" ]; then echo "  全部套件通过"; else echo "  有套件失败"; fi
exit $FAILED
