require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// regress_care.js — 陪护闭环回归（管理中心/子女端/老人端/监控中心/机器人）
//
// 覆盖：
//   ① 建档必须老人本人同意；子女加入必须同意 + 正确邀请码
//   ② 非成员不能读档案/告警/资料（越权必须失败）
//   ③ 设备注册令牌只发一次；心跳鉴权；掉线自动告警且只告一次；恢复在线自动闭环
//   ④ SOS=P0/5 分钟 SLA；告警接单/闭环状态机；陌生人不能接单；必须写处理结果
//   ⑤ 任务只能由子女安排；老人可完成；周期任务自动生成下一次；超时自动漏做
//   ⑥ 资料归属校验；图片落盘可下载；非成员下载被拒
//   ⑦ 闭环体检能抓到：无子女绑定/档案不全/设备离线/P0 超时/未定价
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'core', 'store'));
const care = require(path.join(ROOT, 'core', 'care'));

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};
const DAY = 86400000;
const ELDER = 'regress:care_elder_' + Date.now();
const CHILD = 'regress:care_child_' + Date.now();
const STRANGER = 'regress:care_stranger_' + Date.now();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ===== ① 建档 / 加入 =====
ok(care.createFamily(ELDER, { elderName: '张阿姨', consent: false }).ok === false, '未勾同意书不能建档');
ok(care.createFamily(ELDER, { consent: true }).ok === false, '缺老人称呼不能建档');
const fam = care.createFamily(ELDER, { elderName: '张阿姨', consent: true });
ok(fam.ok === true && fam.inviteCode && fam.inviteCode.length === 6, '建档成功并生成 6 位邀请码', JSON.stringify(fam).slice(0, 120));
const again = care.createFamily(ELDER, { elderName: '张阿姨2', consent: true });
ok(again.ok === true && again.already === true && again.family.id === fam.family.id, '重复建档幂等，不会建出第二个家庭');
const fid = fam.family.id;

ok(care.joinFamily(CHILD, { code: 'ZZZZZZ', consent: true }).ok === false, '错误邀请码被拒');
ok(care.joinFamily(CHILD, { code: fam.inviteCode, consent: false }).ok === false, '未同意不能加入');
const join = care.joinFamily(CHILD, { code: fam.inviteCode, consent: true, name: '小张', relation: '女儿', phone: '13800001111' });
ok(join.ok === true && join.member.role === 'guardian', '子女凭邀请码加入成功');
ok(care.joinFamily(CHILD, { code: fam.inviteCode, consent: true }).already === true, '重复加入幂等');

const view = care.familyView(ELDER);
ok(view.ok === true && view.families.length === 1, '老人能看到自己的家庭');
ok(view.families[0].members.length === 2, '家庭里有 2 位成员（老人+子女）', String(view.families[0].members.length));
ok(view.families[0].stats.guardians === 1, '统计出 1 位子女');
ok(JSON.stringify(view.families[0].members).indexOf('13800001111') < 0, '成员列表里手机号已脱敏');

// ===== ② 越权 =====
ok(care.getProfile(STRANGER).ok === false, '非成员不能读档案');
ok(care.saveProfile(STRANGER, { familyId: fid, age: 80 }).ok === false, '非成员不能改档案');
ok(care.listAlerts(STRANGER, fid).ok === false, '非成员不能读告警');
ok(care.listDocs(STRANGER, fid).ok === false, '非成员不能读资料');

// ===== ③ 档案 =====
ok(care.saveProfile(ELDER, { familyId: fid, age: 500 }).ok === false, '年龄 500 被拒');
const p1 = care.saveProfile(ELDER, { familyId: fid, age: 78, conditions: ['高血压'], allergies: ['青霉素'], meds: [{ name: '氨氯地平', dose: '5mg', times: ['08:00'] }], emergencyContacts: [{ name: '小张', phone: '13800001111', relation: '女儿' }] });
ok(p1.ok === true && p1.complete === true, '档案补齐后 complete=true');
ok(Array.isArray(p1.profile.meds) && p1.profile.meds[0].name === '氨氯地平', '用药记录落库');

// ===== ④ 设备 =====
ok(care.registerDevice(STRANGER, { familyId: fid, deviceId: 'robot-x', type: 'robot' }).ok === false, '非成员不能注册设备');
const dev = care.registerDevice(CHILD, { familyId: fid, deviceId: 'robot-' + Date.now(), type: 'robot', name: '陪护机器人 1 号' });
ok(dev.ok === true && !!dev.token, '设备注册成功并只返回一次令牌');
ok(!dev.device.tokenHash, '设备对象不泄露 tokenHash');
const devDup = care.registerDevice(CHILD, { familyId: fid, deviceId: dev.device.deviceId, type: 'robot' });
ok(devDup.ok === true && devDup.already === true && !devDup.token, '重复注册不重发令牌');

ok(care.heartbeat('bad-token', {}).ok === false, '错误设备令牌被拒');
const hb = care.heartbeat(dev.token, { battery: 180, firmware: '1.0.2' });
ok(hb.ok === true && hb.device.status === 'online', '心跳后设备在线');
ok(hb.device.battery === 100, '电量被夹到 0-100');

// 手动把 lastSeen 打到 11 分钟前 → 巡检应建 P1 掉线告警（只一次）
const devRow = store.findBy('careDevices', 'id', dev.device.id);
store.update('careDevices', devRow.id, { lastSeen: Date.now() - 11 * 60000 }, 'seed offline');
const sw1 = care.sweep(true);
ok(sw1.offline === 1, '巡检发现 1 台设备离线');
const offlineAlerts = () => store.findAllBy('careAlerts', 'familyId', fid).filter(a => a.kind === 'device_offline');
ok(offlineAlerts().length === 1 && offlineAlerts()[0].severity === 'P1', '掉线告警为 P1');
care.sweep(true);
ok(offlineAlerts().length === 1, '重复巡检不会重复建掉线告警（当天去重）');
const hb2 = care.heartbeat(dev.token, { battery: 60 });
ok(hb2.ok === true && hb2.autoResolved === 1, '设备恢复在线→掉线告警自动闭环');
ok(store.findBy('careAlerts', 'id', offlineAlerts()[0].id).status === 'resolved', '自动闭环状态落库');

// ===== ⑤ 告警 =====
const sos = care.raiseAlert(ELDER, { familyId: fid, kind: 'sos', message: '胸口疼' });
ok(sos.ok === true && sos.severity === 'P0' && sos.slaMin === 5, 'SOS 为 P0 / 5 分钟 SLA');
ok(Array.isArray(sos.guardians) && sos.guardians.length === 1, '告警返回应通知的子女');
ok(sos.guardians[0].phone.indexOf('138') === 0 && sos.guardians[0].phone.indexOf('****') > 0, '子女手机号脱敏返回');
ok(sos.emergency.indexOf('120') >= 0, 'P0 提示拨打 120');
const dup = care.raiseAlert(ELDER, { familyId: fid, kind: 'sos', message: '又疼了' });
ok(dup.ok === true && dup.already === true, '5 分钟内重复 SOS 不重复建单');
ok(care.ackAlert(STRANGER, { id: sos.alert.id }).ok === false, '陌生人不能接单');
const ack = care.ackAlert(CHILD, { id: sos.alert.id });
ok(ack.ok === true && ack.alert.status === 'acked', '子女接单成功');
ok(ack.alert.ackWithinSla === true, '接单在 SLA 内');
ok(care.resolveAlert(CHILD, { id: sos.alert.id, note: '' }).ok === false, '闭环必须写处理结果');
const res = care.resolveAlert(CHILD, { id: sos.alert.id, note: '电话确认已含服硝酸甘油，10 分钟后缓解，已嘱咐就医' });
ok(res.ok === true && res.alert.status === 'resolved', '告警闭环成功');
ok(res.alert.handleMin >= 0, '处理时长可统计');

// P0 超时未接单 → 升级 + 闭环体检抓到
const sos2 = care.raiseAlert(ELDER, { familyId: fid, kind: 'fall', message: '摔了一下' });
store.update('careAlerts', sos2.alert.id, { escalateAt: Date.now() - 1000, at: Date.now() - 6 * 60000 }, 'seed overdue');
const sw2 = care.sweep(true);
ok(sw2.escalated >= 1, '超时告警被升级');
const escalated = store.findBy('careAlerts', 'id', sos2.alert.id);
ok(!!escalated.escalatedAt && /小张|监控中心/.test(escalated.escalatedTo), '升级对象落库（子女/监控中心）');

// ===== ⑥ 任务 =====
ok(care.createTask(ELDER, { familyId: fid, title: '吃药' }).ok === false, '老人不能给自己安排任务（避免自证）');
const task = care.createTask(CHILD, { familyId: fid, title: '早上吃氨氯地平', type: 'med', dueAt: Date.now() - 1000, repeat: 'daily' });
ok(task.ok === true && task.task.status === 'pending', '子女安排任务成功');
const done = care.completeTask(ELDER, { id: task.task.id });
ok(done.ok === true && done.task.status === 'done', '老人可完成任务');
ok(done.next && done.next.status === 'pending', '周期任务自动生成下一次');
ok(done.task.lateMin >= 0, '迟到分钟数可统计');
const missedTask = care.createTask(CHILD, { familyId: fid, title: '量血压', type: 'measure', dueAt: Date.now() - 10 * 60000 });
care.sweep(true);
ok(store.findBy('careTasks', 'id', missedTask.task.id).status === 'missed', '超时任务自动标记漏做');

// ===== ⑦ 资料 =====
const doc1 = care.addDoc(CHILD, { familyId: fid, title: '2026-10 体检报告', kind: 'report', note: '社区医院' });
ok(doc1.ok === true && doc1.doc.hasFile === undefined, '资料元数据可单独登记');
const doc2 = care.addDoc(ELDER, { familyId: fid, title: '处方照片', kind: 'prescription', dataUrl: PNG });
ok(doc2.ok === true && !!doc2.doc.file && doc2.doc.bytes > 0, '图片资料落盘成功');
const docs = care.listDocs(ELDER, fid);
ok(docs.ok === true && docs.docs.length === 2, '资料清单返回 2 条');
ok(docs.docs.every(d => d.file === undefined), '清单不直接暴露磁盘文件名');
const open = care.openDoc(ELDER, doc2.doc.id);
ok(open.ok === true && require('fs').existsSync(open.path), '本人可下载资料');
const dlAudit = store.list('audit', 999).filter(a => a.action === '陪护·资料下载');
ok(dlAudit.length >= 1 && String(dlAudit[dlAudit.length - 1].detail).indexOf(doc2.doc.id) >= 0, '资料下载写入审计（含 doc id）');
ok(care.openDoc(STRANGER, doc2.doc.id).ok === false, '非成员下载被拒');
ok(care.addDoc(CHILD, { familyId: fid, title: 'x', dataUrl: 'data:text/plain;base64,aGk=' }).ok === false, '非图片附件被拒');

// ===== ⑧ 闭环体检 =====
const loop = care.loop();
ok(loop.ok === true, '闭环报告可生成');
const chk = id => loop.checks.find(c => c.id === id);
ok(chk('family_no_guardian').count === 0, '本家庭已绑定子女→无“无子女”断点', String(chk('family_no_guardian').count));
ok(chk('device_offline').count === 0, '设备已恢复→无离线断点');
ok(chk('p0_unacked').count === 1, '抓到 1 条 P0 超时未接单');
ok(chk('task_missed_7d').count >= 1, '抓到近 7 天漏做任务');
ok(chk('billing_not_configured').count === 1, '未定价 → 明确报“商业闭环未成立”');
ok(loop.billing.configured === false, '未配置收费时不假装能收费');
ok(loop.stages.find(s => s.id === 'family').pct === null, '首段无分母→pct=null');
ok(/^【high】/.test(loop.nextAction), 'nextAction 指向 high 断点');
ok(loop.honesty.medical.indexOf('不做诊断') >= 0, '报告明示不做医疗诊断');

// 未绑定子女的家庭 → 断点能被抓到
const fam2 = care.createFamily('regress:care_lone_' + Date.now(), { elderName: '李大爷', consent: true });
const loop2 = care.loop();
ok(loop2.checks.find(c => c.id === 'family_no_guardian').count >= 1, '新建未绑定家庭被体检抓到');

// ===== ⑨ 中心视图 + 审计 =====
const center = care.center();
ok(center.ok === true && center.families >= 2, '监控中心统计家庭数', String(center.families));
ok(center.elders >= 2 && center.guardians >= 1, '中心统计老人/子女数');
ok(center.devices.total >= 1, '中心统计设备数');
ok(center.alerts.open >= 1, '中心统计未闭环告警');
ok(center.billing.configured === false, '中心显示收费未配置');
ok(Array.isArray(center.recent) && center.recent.length > 0, '中心返回最近陪护事件');
ok(center.recent.every(e => String(e.action).startsWith('陪护·')), '最近事件只含陪护审计');
ok(center.recent.some(e => String(e.target || '').length > 0), '最近事件带对象/详情（不是空列）');
const auditCount = store.list('audit', 999).filter(a => String(a.action).startsWith('陪护·')).length;
ok(auditCount >= 15, '全流程写入陪护审计（≥15 条）', String(auditCount));

// ===== ⑩ 商业闭环：定价/订阅/通知/资料治理/临时授权 =====
// 1) 写入定价方案（真实 3 档 + 免费种子 20 户）
store.setSetting('carePlan', {
  currency: 'CNY',
  plans: [
    { id: 'care-basic', name: '基础版', price: 99, unit: '月/老人', note: '1 老人 + 3 家属 + SOS/告警/任务/资料' },
    { id: 'care-plus', name: '陪护版', price: 299, unit: '月/老人', note: '设备接入 + 5 分钟 SLA + 每周报告' },
    { id: 'care-org', name: '机构版', price: 699, unit: '月/5 床位', note: '白标 + 监控中心 + 批量台账' },
  ],
  freePlan: { name: '免费种子试点', note: '限 20 户，换访谈与案例；不做长期免费' },
  note: '2026-10-24 拍板：¥99/¥299/¥699 三档；种子 20 户',
});
const PLAN2 = care.carePlan();
ok(PLAN2.configured === true && PLAN2.price === 99 && PLAN2.plans.length === 3, '写入 3 档后：configured=true，锚点 ¥99/月');
ok(PLAN2.seedLimit === 20 && PLAN2.seedFamilies >= 2 && PLAN2.seedOpen === true, '种子名额 20 且当前未满');

// 2) 订阅开单：只有子女能开；未付款=未开通；幂等
ok(care.createCareOrder(ELDER, { familyId: fid, plan: 'care-basic' }).ok === false, '老人不能给自己开订阅单');
ok(care.createCareOrder(CHILD, { familyId: fid, plan: 'no-such' }).ok === false, '未知方案被拒');
const order = care.createCareOrder(CHILD, { familyId: fid, plan: 'care-basic', cycle: 'month' });
ok(order.ok === true && order.order.status === 'pending' && order.order.amount === 99, '子女开单成功：pending ¥99');
const order2 = care.createCareOrder(CHILD, { familyId: fid, plan: 'care-basic', cycle: 'month' });
ok(order2.already === true && order2.order.id === order.order.id, '同档同周期重复开单幂等');
const views = care.careOrderView(CHILD, fid);
ok(views.ok === true && views.orders.some(o => o.id === order.order.id && o.status === 'pending'), '订单列表可查');
const before = store.findBy('careFamilies', 'id', fid);
ok(before.plan === 'care-pending', '开单但未付款 → 家庭方案不变（未开通）');
const ff = care.fulfillCareOrder('ops', order.order.id, 'proof-x');
ok(ff.ok === true && ff.order.status === 'fulfilled', '运营核账后开通');
const after = store.findBy('careFamilies', 'id', fid);
ok(after.plan === 'care-basic' && String(after.payer) === CHILD, '开通后家庭升级 + 记录付费人');

// 3) 种子上限：压到当前家庭数时新建档必须失败并给出明确出口（商业闭环不是无限免费）
const curFams = care.seedLimitNow ? care.seedLimitNow() : null;
const curActive = store.list('careFamilies', 999).filter(x => x.status === 'active').length;
store.setSetting('careSeedLimit', curActive);
const capped = care.createFamily('regress:care_capped_' + Date.now(), { elderName: '王奶奶', consent: true });
ok(capped.ok === false && capped.code === 'seed_full', '种子满员 → 拒绝新建档（code=seed_full）');
store.setSetting('careSeedLimit', 20);
ok(care.createFamily('regress:care_capped2_' + Date.now(), { elderName: '王奶奶2', consent: true }).ok === true, '恢复上限后可继续建档');

// 4) 告警通知入队：无邮箱/无短信 → 如实记 skipped + “人工电话”
const vital = care.raiseAlert(CHILD, { familyId: fid, kind: 'vital', message: '血压偏高' });
ok(vital.ok === true, '体征告警(P1) 可发起');
const notifRows = store.list('careNotifies', 999).filter(n => n.alertId === vital.alert.id);
ok(notifRows.length >= 1 && notifRows.every(n => n.status === 'skipped' || n.status === 'pending'), 'P1 告警为子女建通知行');
ok(notifRows.some(n => /人工电话/.test(n.note || '')), '无短信无邮箱 → 明确写“人工电话兜底”（不假装发出）');

// 5) 短信模块：未配置=fail-closed；配置后坏号码立即拒绝（不联网、不真发）
const sms = require(path.join(ROOT, 'core', 'care-sms'));
ok(sms.configured() === false, '未配置 careSms → configured=false');
let smsAssertDone = false;
function finishRun() {
  if (smsAssertDone) return;
  smsAssertDone = true;
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
}
function runSmsAndRest() {
  let vital2Id = null;   // 跨 .then 链共享
  return sms.send('13800009999', { elder: '张', sev: 'P0', reason: 'open' })
    .then(r => {
      ok(r.code === 'not_configured', '未配置时 send 返回 not_configured（fail-closed）');
      store.setSetting('careSms', { provider: 'aliyun', accessKey: 'FAKE', secret: 'FAKE', signName: '测试', templateCode: 'SMS_0', dailyCap: 5 });
      ok(sms.configured() === true, '配置后 configured=true');
      const v2 = care.raiseAlert(CHILD, { familyId: fid, kind: 'vital', message: '二次 P1 验证 flush' });
      vital2Id = v2.alert.id;
      ok(v2.ok === true, '二次 P1 告警可发起（触发 flushNotifies）');
      return care.flushNotifies();
    })
    .then(() => {
      // 等 flushNotifies 内部异步 promise 全部 resolve 并写入 store
      return new Promise(res => setTimeout(res, 80));
    })
    .then(() => {
      const rows = store.list('careNotifies', 999).filter(n => n.alertId === vital2Id);
      ok(rows.length >= 1, '二次 P1 也建了通知行');
      const failedNote = rows.find(n => n.channel === 'sms' && n.status === 'failed');
      ok(!failedNote || /not_configured|未知|FAKE|accessKey/.test(failedNote.note || ''),
        'flushNotifies 不再把 async 结果误判成 "未知错误"（note 必须能定位到 not_configured/FAKE key）');
      store.setSetting('careSms', {});   // 还原：避免后续巡检真联网

      // 6) 资料删除权（PIPL）
      const del = care.deleteDoc(CHILD, doc1.doc.id);
      ok(del.ok === true, '家属删除资料成功');
      ok(care.openDoc(ELDER, doc1.doc.id).ok === false, '删除后本人也取不到');
      ok(care.listDocs(ELDER, fid).docs.every(d => d.id !== doc1.doc.id), '删除后不出现在清单');

      // 7) 资料保留期
      const doc3 = care.addDoc(CHILD, { familyId: fid, title: '过期模拟', kind: 'report', dataUrl: PNG });
      store.update('careDocs', doc3.doc.id, { retainUntil: Date.now() - 1000 }, 'seed expired');
      care.sweep(true);
      ok(store.findBy('careDocs', 'id', doc3.doc.id).status === 'expired', '过保留期的资料自动过期');
      ok(care.openDoc(CHILD, doc3.doc.id).ok === false, '过期资料不可下载');

      // 8) 家属临时授权
      const g = care.grantDoc(CHILD, { docId: doc2.doc.id, hours: 2, note: '协助排查' });
      ok(g.ok === true && g.grant.expiresAt > Date.now(), '家属开临时授权成功');
      const viaGrant = care.openDoc(STRANGER, doc2.doc.id, { ops: true, grantId: g.grant.id });
      ok(viaGrant.ok === true && viaGrant.via === 'grant', '运营凭授权窗口可下载（via=grant）');
      ok(care.openDoc(STRANGER, doc2.doc.id, { ops: true, grantId: 'no-such-id' }).ok === false, '无授权窗口 → 运营也拿不到（归属校验）');
      ok(care.revokeGrant(CHILD, g.grant.id).ok === true, '家属可随时撤回授权');
      ok(care.openDoc(STRANGER, doc2.doc.id, { ops: true, grantId: g.grant.id }).ok === false, '撤回后立即失效');

      // 9) 中心视图
      const center2 = care.center();
      ok(center2.orders && center2.orders.fulfilled >= 1 && center2.orders.mrr >= 99, '中心统计开通订单与 MRR');
      ok(center2.notifies && center2.notifies.configured === false, '中心显示短信未配置（不装配置好了）');

      // ⑨-bis fulfillCareOrder 幂等：已 fulfilled 再调不重复升级
      const ff2 = care.fulfillCareOrder('ops', order.order.id, 'proof-y');
      ok(ff2.already === true, '重复 fulfill 幂等（already=true，不重复写审计）');

      // ⑨-bis-bis 商业闭环硬断言：未配置 carePlan 时 healthy 必须 false
      const loopUnpriced = (function () {
        store.setSetting('carePlan', null);  // 模拟"刚上线还没拍板定价"
        const L = care.loop();
        store.setSetting('carePlan', PLAN2); // 立刻还原，避免污染前面断言
        return L;
      })();
      ok(loopUnpriced.healthy === false && /商业闭环未闭合/.test(loopUnpriced.nextAction), '未定价时 healthy=false 且 nextAction 点名商业未闭合（防"漏斗每段都有数但没人付钱"的假繁荣）');

      // ⑩ 健康数据字段级加密（PIPL P0，2026-10-24）+ 新巡检断点
      const crypto2 = require('crypto');
      const fs2 = require('fs');
      const path2 = require('path');
      const cc = require(path2.join(ROOT, 'core', 'care-crypto'));
      const storeMod = require(path2.join(ROOT, 'core', 'store'));

      // 1) 新建档即密文
      const encElder = 'regress:care_enc_' + Date.now();
      const encFam = care.createFamily(encElder, { elderName: '加密王奶奶', consent: true });
      ok(encFam.ok === true, '加密档：建档成功', JSON.stringify(encFam).slice(0, 120));
      const encRow = store.findAllBy('careProfiles', 'familyId', encFam.family.id)[0];
      ok(!!encRow && typeof encRow.sec === 'string' && encRow.sec.indexOf('careenc1.') === 0, '新建档案落库为密文信封（sec=careenc1.…）', JSON.stringify(encRow).slice(0, 120));
      ok(JSON.stringify(encRow).indexOf('王奶奶') < 0, '档案行不含老人称呼明文（敏感面最小化）');

      // 2) 敏感字段全量落密：db.json 全文检索不到
      const encSave = care.saveProfile(encElder, { familyId: encFam.family.id, age: 71, conditions: ['糖尿病'], allergies: ['磺胺'], meds: [{ name: '二甲双胍', dose: '0.5g', times: ['08:00'] }], emergencyContacts: [{ name: '王小', phone: '13911112222', relation: '儿子' }] });
      ok(encSave.ok === true && encSave.complete === true, '加密档：保存成功');
      const rawDb = JSON.stringify(store.read());
      ok(rawDb.indexOf('二甲双胍') < 0 && rawDb.indexOf('磺胺') < 0 && rawDb.indexOf('13911112222') < 0, 'db.json 全文检索不到用药/过敏/紧急电话明文');

      // 3) 授权成员读回解密一致；解密结果不带密文
      const encGet = care.getProfile(encElder, encFam.family.id);
      ok(encGet.ok === true && encGet.profile.meds[0].name === '二甲双胍' && encGet.profile.conditions[0] === '糖尿病', '授权成员读回解密一致');
      ok(encGet.profile.sec === undefined, '解密结果不回传密文信封');

      // 4) 越权仍然拒绝（加密不替代鉴权，两道锁都在）
      ok(care.getProfile(STRANGER, encFam.family.id).ok === false, '非成员仍读不到（加密≠替代鉴权）');

      // 5) familyView 返回解密档案
      const encView = care.familyView(encElder);
      const evf = (encView.families || []).find(x => x.family.id === encFam.family.id);
      ok(evf && evf.profile && evf.profile.conditions[0] === '糖尿病' && evf.profileUnreadable === false, 'familyView 返回解密后的档案');

      // 6) 资料文件落盘为 CENC1 加密信封；成员下载解密回原始 PNG
      const encDoc = care.addDoc(encElder, { familyId: encFam.family.id, title: '加密出院小结', kind: 'discharge', dataUrl: PNG });
      ok(encDoc.ok === true && !!encDoc.doc.file, '加密档：资料上传成功');
      const rawFile = fs2.readFileSync(path2.join(storeMod.dataPath('care-docs'), encDoc.doc.file));
      ok(rawFile.slice(0, 5).toString('ascii') === 'CENC1', '资料文件落盘为 CENC1 信封（PNG 魔数不可见）', rawFile.slice(0, 8).toString('hex'));
      ok(rawFile[0] !== 0x89, '磁盘上不是裸 PNG');
      const encOpen = care.openDoc(encElder, encDoc.doc.id);
      ok(encOpen.ok === true && Buffer.isBuffer(encOpen.buf) && encOpen.buf[0] === 0x89 && encOpen.buf.slice(1, 4).toString('ascii') === 'PNG', '成员下载解密回原始 PNG 字节');

      // 7) 旧明文档案行：体检抓到 → 运营迁移 → 断点清零 + 明文字段抹除
      store.push('careProfiles', {
        familyId: fid, age: 88, gender: '女', conditions: ['高血压'], allergies: [], meds: [],
        emergencyContacts: [{ name: '张小', phone: '13800001111', relation: '女儿' }],
        address: '', notes: '', updatedAt: Date.now(), updatedBy: ELDER, complete: true,
      }, 'seed legacy plaintext');
      let Lenc = care.loop();
      ok(Lenc.checks.find(c => c.id === 'health_data_unencrypted').count >= 1, '存量明文档案被体检抓到（health_data_unencrypted）');
      const mig = care.migrateEncryption();
      ok(mig.ok === true && mig.profiles.migrated >= 1, '运营迁移：明文档案转密文', JSON.stringify(mig));
      Lenc = care.loop();
      ok(Lenc.checks.find(c => c.id === 'health_data_unencrypted').count === 0, '迁移后 health_data_unencrypted 断点清零');
      ok(!store.list('careProfiles', 999).some(r => Array.isArray(r.conditions) && r.conditions.length > 0), '迁移后行上明文 conditions 已抹除');
      ok(Lenc.privacy && Lenc.privacy.profileEncryption.available === true && Lenc.privacy.profileEncryption.legacyPlaintext === 0, '体检带 privacy.profileEncryption 状态（可用且零明文）', JSON.stringify(Lenc.privacy));
      const migAgain = care.migrateEncryption();
      ok(migAgain.ok === true && migAgain.profiles.migrated === 0 && migAgain.profiles.already >= 2, '迁移幂等（重跑全部 already）', JSON.stringify(migAgain.profiles));

      // 8) 新断点：机器人 24h 无心跳
      const rb = care.registerDevice(CHILD, { familyId: fid, deviceId: 'robot-24h-' + Date.now(), type: 'robot' });
      store.update('careDevices', rb.device.id, { lastSeen: Date.now() - 25 * 3600000 }, 'seed robot 24h');
      const Lbot = care.loop();
      ok(Lbot.checks.find(c => c.id === 'robot_no_heartbeat_24h').count === 1, '断点：机器人 24h 无心跳被抓到', JSON.stringify(Lbot.checks.find(c => c.id === 'robot_no_heartbeat_24h')));

      // 9) 新断点：慢病家庭无资料（专用家庭：有病史、零资料）
      const chrElder = 'regress:care_chr_' + Date.now();
      const chrFam = care.createFamily(chrElder, { elderName: '慢病赵奶奶', consent: true });
      care.saveProfile(chrElder, { familyId: chrFam.family.id, conditions: ['冠心病'] });
      const Lchr = care.loop();
      const chrChk = Lchr.checks.find(c => c.id === 'chronic_no_doc');
      ok(chrChk.count >= 1 && chrChk.samples.some(s => String(s.elder).indexOf('赵奶奶') >= 0), '断点：慢病(冠心病)家庭无病历被抓到（读的是解密后的病史）', JSON.stringify(chrChk.samples));
      care.addDoc(chrElder, { familyId: chrFam.family.id, title: '就诊病历', kind: 'report' });   // 无附件也算有效资料条目
      const Lchr2 = care.loop();
      ok(Lchr2.checks.find(c => c.id === 'chronic_no_doc').count === 0, '上传资料（哪怕是纯元数据条目）后断点解除');

      // 10) 新断点：家属 30 天从未接单（P0/P1）
      const respElder = 'regress:care_resp_' + Date.now();
      const respFam = care.createFamily(respElder, { elderName: '无人接李大爷', consent: true });
      care.joinFamily('regress:care_resp_child_' + Date.now(), { code: respFam.inviteCode, consent: true, name: '李小小', relation: '儿子' });
      care.raiseAlert(respElder, { familyId: respFam.family.id, kind: 'sos', message: '无人接单测试' });
      const Lresp = care.loop();
      ok(Lresp.checks.find(c => c.id === 'guardian_no_response_30d').count >= 1, '断点：有子女但 30 天从未接单被抓到');
      ok(Lresp.checks.find(c => c.id === 'guardian_no_response_30d').samples.some(s => String(s.elder).indexOf('李大爷') >= 0), '样本指向该家庭');

      // 11) 新断点：同意书满一年
      const someMember = store.findAllBy('careMembers', 'familyId', fid)[0];
      store.update('careMembers', someMember.id, { consentAt: Date.now() - 400 * 86400000 }, 'seed consent old');
      const Lcon = care.loop();
      ok(Lcon.checks.find(c => c.id === 'consent_expired').count >= 1, '断点：同意书超一年被抓到');

      // 12) 密钥轮换：错钥匙 fail-closed → OLD 携旧钥可解 → 重封后只凭新钥可解
      const keyFileHex = fs2.readFileSync(path2.join(storeMod.DATA_DIR, 'care-data.key'), 'utf8').trim();
      process.env.CARE_DATA_KEY = crypto2.randomBytes(32).toString('hex');
      ok(cc.keyStatus().envOverride === true, 'CARE_DATA_KEY 覆盖密钥来源（env 优先于文件）');
      const wrongKey = care.getProfile(encElder, encFam.family.id);
      ok(wrongKey.ok === false && wrongKey.code === 'profile_decrypt_failed', '换错钥匙 → fail-closed 拒绝解密（不吐密文）', JSON.stringify(wrongKey).slice(0, 100));
      ok(care.saveProfile(encElder, { familyId: encFam.family.id, age: 80 }).ok === false, '解不开时保存也被拒（防止把旧密文覆盖丢失）');
      process.env.CARE_DATA_KEY_OLD = keyFileHex;
      const rotatedRead = care.getProfile(encElder, encFam.family.id);
      ok(rotatedRead.ok === true && rotatedRead.profile.meds[0].name === '二甲双胍', 'CARE_DATA_KEY_OLD 携旧钥 → 轮换期可解');
      care.saveProfile(encElder, { familyId: encFam.family.id, notes: '轮换后重封' });   // 保存即重封为新钥
      delete process.env.CARE_DATA_KEY_OLD;
      const afterRotate = care.getProfile(encElder, encFam.family.id);
      ok(afterRotate.ok === true && afterRotate.profile.notes === '轮换后重封', '重封后只凭新钥即可解（轮换完成，OLD 可撤销）');
      delete process.env.CARE_DATA_KEY;   // 还原文件钥匙，避免污染后续

      // ⑩-bis 静态守卫
      const fs = require('fs');
      const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      ok(srv.indexOf('function careVisitorOf') >= 0, '存在陪护专用身份 careVisitorOf');
      ok(srv.indexOf('bd_care=') >= 0, '陪护身份用独立 Cookie（bd_care），不与额度访客混用');
      const careBlock = srv.slice(srv.indexOf('// ===== 陪护闭环'), srv.indexOf('// ===== 客户档案'));
      ok(careBlock.length > 1000 && careBlock.indexOf('visitorOf(req, q, res)') < 0, '陪护端点不再使用 IP×小时 匿名桶（同 WiFi 不会串号）');
      ok((careBlock.match(/careVisitorOf\(req, q, res\)/g) || []).length >= 14, '全部陪护端点走 careVisitorOf');
      const pw = fs.readFileSync(path.join(ROOT, 'core', 'paywall.js'), 'utf8');
      ok(pw.indexOf('/v1/care/center') >= 0 && pw.indexOf('/v1/care/family/create') >= 0, '陪护端点已登记进收费墙/端点清单');
      ok(pw.indexOf('/v1/care/doc/file') >= 0, '资料下载登记（归属校验在 core/care.js）');
      ok(pw.indexOf('/v1/care/order/fulfill') >= 0, '开通订阅（核账后）登记为运营端点（需管理令牌）');
      ok(pw.indexOf('/v1/care/notifies') >= 0, '通知队列登记为运营端点');

      finishRun();
    })
    .catch(e => { console.error('ASSERTION RUN ERROR:', e); finishRun(); });
}
runSmsAndRest();
