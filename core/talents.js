// core/talents.js — 行业人才库：120+ 各行各业真实岗位画像
// 作用：组织大脑一键导入各行业人才（生成真实数据落库），覆盖面广、价值密度高。
// 结构：20 大行业 × 6 岗位 = 120 个岗位，每种岗位含 角色/技能组/职责描述。

const INDUSTRIES = [
  {
    id: 'tech', name: '互联网科技', emoji: '💻',
    jobs: [
      { role: '全栈工程师', skills: ['TypeScript', 'React', 'Node.js', '微服务'], desc: '负责前后端全链路开发与接口设计' },
      { role: '前端架构师', skills: ['React', 'Vue', 'WebGL', '性能优化'], desc: '搭建高复用前端架构与组件体系' },
      { role: '后端架构师', skills: ['Golang', 'Kafka', '高并发', '缓存设计'], desc: '设计高可用服务端与数据链路' },
      { role: 'iOS 工程师', skills: ['Swift', 'UIKit', 'App Store', '性能调优'], desc: '负责 iOS 客户端研发与上架' },
      { role: 'Android 工程师', skills: ['Kotlin', 'Jetpack', 'Gradle', '多渠道'], desc: '负责 Android 客户端研发与发布' },
      { role: 'DevOps 工程师', skills: ['Docker', 'K8s', 'CI/CD', '可观测性'], desc: '搭建持续交付与自动化运维体系' }
    ]
  },
  {
    id: 'ai', name: '人工智能', emoji: '🤖',
    jobs: [
      { role: 'NLP 算法工程师', skills: ['LLM', 'RAG', 'Transformer', 'Prompt'], desc: '构建大模型应用与知识检索增强' },
      { role: 'CV 算法工程师', skills: ['PyTorch', '目标检测', '图像分割', 'ONNX'], desc: '开发视觉识别与图像理解算法' },
      { role: '推荐算法工程师', skills: ['召回', '排序', 'Embedding', 'AB测试'], desc: '优化个性化推荐系统线上指标' },
      { role: '数据标注专家', skills: ['标注规范', '质量管理', '众包管理'], desc: '把控训练数据质量与标注流程' },
      { role: 'MLOps 工程师', skills: ['模型部署', '特征平台', '监控', 'K8s'], desc: '打通模型训练到上线的自动化链路' },
      { role: 'AI 产品经理', skills: ['需求分析', '大模型应用', '原型', 'ROI'], desc: '定义 AI 产品功能与商业化路径' }
    ]
  },
  {
    id: 'fin', name: '金融投资', emoji: '💰',
    jobs: [
      { role: '量化研究员', skills: ['Python', '因子挖掘', '回测', '风险控制'], desc: '研发量化策略并控制回撤' },
      { role: '投资经理', skills: ['估值', '行业研究', '组合管理', '投后'], desc: '管理投资组合与项目尽调' },
      { role: '风控专家', skills: ['信用评估', '巴塞尔', '压力测试', '合规'], desc: '建立风控体系与预警机制' },
      { role: '合规分析师', skills: ['监管合规', '反洗钱', '内审', '披露'], desc: '确保业务符合监管要求' },
      { role: '财务分析师', skills: ['三张表', '预算', '折旧', '敏感性分析'], desc: '输出财务模型与经营分析' },
      { role: '金融产品经理', skills: ['产品设计', '支付', '风控', '用户体验'], desc: '设计金融产品与交易流程' }
    ]
  },
  {
    id: 'health', name: '医疗健康', emoji: '🏥',
    jobs: [
      { role: '医学影像分析师', skills: ['影像诊断', 'AI辅助', '报告撰写'], desc: '结合 AI 辅助出具影像解读' },
      { role: '临床研究员', skills: ['GCP', '试验设计', '数据管理', 'CRF'], desc: '组织药物临床研究全过程' },
      { role: '健康管理师', skills: ['慢病管理', '营养', '运动处方', '随访'], desc: '制定慢病与康复管理方案' },
      { role: '数字医疗产品经理', skills: ['互联网医院', '电子病历', '数据合规'], desc: '规划数字医疗产品与流程' },
      { role: '医疗数据分析师', skills: ['DRG', '病案', '医保', '可视化'], desc: '分析诊疗与医保运营数据' },
      { role: '药企市场策略', skills: ['药械准入', 'KOL', '学术推广', '竞品'], desc: '制定药品市场策略与准入路径' }
    ]
  },
  {
    id: 'edu', name: '教育培训', emoji: '🎓',
    jobs: [
      { role: '课程设计专家', skills: ['教学设计', '蓝本', '评估模型'], desc: '设计系统化课程体系与大纲' },
      { role: '学科名师', skills: ['考点把握', '讲义', '提分'], desc: '主讲核心学科并打磨讲义' },
      { role: '在线教育产品经理', skills: ['直播', 'AI伴学', '转化', '留存'], desc: '负责在线教学产品迭代与转化' },
      { role: '教研员', skills: ['教材', '教研', '题库'], desc: '沉淀教学资源与教研方法论' },
      { role: '教育心理咨询师', skills: ['学习动机', '亲子沟通', '测评'], desc: '支持学生心理与学习状态辅导' },
      { role: '培训运营', skills: ['招生', '社群', '复购', '口碑'], desc: '负责培训项目运营与增长' }
    ]
  },
  {
    id: 'manufacturing', name: '智能制造', emoji: '🏭',
    jobs: [
      { role: '工业自动化工程师', skills: ['PLC', 'SCADA', '机器人', 'MES'], desc: '搭建产线自动化与数据采集' },
      { role: '质量管理工程师', skills: ['SPC', '六西格玛', 'FMEA', 'APQP'], desc: '建立全面质量管理与改进机制' },
      { role: '供应链计划员', skills: ['MRP', 'APS', '安全库存', '产能'], desc: '制定生产计划与排程' },
      { role: '工艺工程师', skills: ['工艺路线', '工装', '降本', 'SOP'], desc: '优化制造工艺与工序标准' },
      { role: '设备维护工程师', skills: ['TPM', '预测性维护', '备件', '点检'], desc: '保障设备稳定运行与维修' },
      { role: '精益生产顾问', skills: ['精益', 'VSM', '看板', '改善周'], desc: '推动产线精益持续改善' }
    ]
  },
  {
    id: 'energy', name: '新能源双碳', emoji: '⚡',
    jobs: [
      { role: '光伏系统工程师', skills: ['PV', '屋顶电站', '仿真', '并网'], desc: '设计光伏电站系统与并网方案' },
      { role: '储能系统工程师', skills: ['BMS', 'PCS', '安全', 'EMS'], desc: '开发储能系统集成与控制策略' },
      { role: '碳核算师', skills: ['ISO14064', '碳盘查', 'CBAM', '减排'], desc: '开展企业碳排放核算与规划' },
      { role: '风电总工', skills: ['叶片', '载荷', '选址', '运维'], desc: '主导风电场设计与全生命周期管理' },
      { role: '充电网络产品经理', skills: ['充电桩', '运营商', '结算', '地推'], desc: '规划充电网络布局与运营' },
      { role: '绿电交易专家', skills: ['电力交易', '绿证', 'PPA', '现货'], desc: '开展绿电采购与交易策略' }
    ]
  },
  {
    id: 'retail', name: '零售电商', emoji: '🛒',
    jobs: [
      { role: '电商运营组长', skills: ['销售额', '流量', '转化率', '大促'], desc: '负责店铺运营与销售达成' },
      { role: '直播电商操盘手', skills: ['选品', '话术', '投流', '排期'], desc: '操盘直播带货全链路' },
      { role: '供应链采购', skills: ['供应商', '议价', '库存', '周转'], desc: '管理采购与供应链成本' },
      { role: '商品企划', skills: ['品类规划', '定价', '毛利', '上新'], desc: '制定商品组合与上新节奏' },
      { role: '私域运营', skills: ['企业微信', '社群', 'SOP', '复购'], desc: '搭建私域用户增长体系' },
      { role: '新零售分析师', skills: ['动销', '选址', '坪效', 'BI'], desc: '以数据驱动门店与渠道决策' }
    ]
  },
  {
    id: 'food', name: '餐饮食品', emoji: '🍜',
    jobs: [
      { role: '研发主厨', skills: ['菜品', 'SOP', '成本率', '包规'], desc: '研发可复制品牌化菜品' },
      { role: '门店运营督导', skills: ['巡店', '值班', 'QSC', '人才'], desc: '保障门店运营标准与人效' },
      { role: '食品安全工程师', skills: ['HACCP', '追溯', '检验', '体系'], desc: '构建食品安全质量管理体系' },
      { role: '餐饮选址专家', skills: ['人流', '商圈', '租金', '模型'], desc: '评估选址并输出收益模型' },
      { role: '食品电商运营', skills: ['O2O', '团购', '会员', '活动'], desc: '运营品牌线上渠道与复购' },
      { role: '品牌加盟经理', skills: ['连锁', '加盟', '单店模型', '赋能'], desc: '拓展连锁与加盟网络' }
    ]
  },
  {
    id: 'travel', name: '文旅出行', emoji: '✈️',
    jobs: [
      { role: '文旅规划师', skills: ['景区', 'IP', '动线', '运营'], desc: '规划文旅项目与业态组合' },
      { role: '旅游产品经理', skills: ['线路', '资源', '定价', '落地'], desc: '设计特色旅游产品线路' },
      { role: '酒店收益管理', skills: ['REVPAR', 'OTA', '议价', '预测'], desc: '优化酒店收益与渠道组合' },
      { role: '出行数据科学家', skills: ['OD分析', '调度', '价格预测', 'GIS'], desc: '用数据优化出行与调度效率' },
      { role: '文旅新媒体', skills: ['内容', '短视频', '种草', '转化'], desc: '打造文旅目的地线上内容' },
      { role: '签证移民顾问', skills: ['政策', '材料', '合规', '咨询'], desc: '提供签证与移民专业咨询' }
    ]
  },
  {
    id: 'marketing', name: '市场品牌', emoji: '📣',
    jobs: [
      { role: '品牌策略总监', skills: ['定位', 'VI', '心智', 'campaign'], desc: '制定品牌定位与传播战役' },
      { role: '增长黑客', skills: ['AARRR', '实验', '裂变', '数据分析'], desc: '搭建增长实验与用户循环' },
      { role: 'SEO 专家', skills: ['关键词', '友链', '收录', '内容矩阵'], desc: '优化搜索引擎自然排名' },
      { role: '效果广告优化师', skills: ['信息流', 'SEM', 'ROI', '素材'], desc: '优化投放 ROI 与素材转化' },
      { role: '公关总监', skills: ['媒体', '危机公关', '发布会', '舆情'], desc: '维护品牌声誉与媒体关系' },
      { role: '活动策划', skills: ['发布会', '展会', '预算', '执行'], desc: '策划执行品牌线下活动' }
    ]
  },
  {
    id: 'media', name: '传媒娱乐', emoji: '🎬',
    jobs: [
      { role: '编剧策划', skills: ['剧本', '大纲', '人设', '梗'], desc: '创作剧本与内容策划' },
      { role: '短视频编导', skills: ['脚本', '拍摄', '剪辑', '爆款'], desc: '生产高传播短视频内容' },
      { role: 'MCN 运营', skills: ['达人', '签约', '商单', '矩阵'], desc: '运营达人矩阵与商业化' },
      { role: '音频主播', skills: ['声线', '节目', '互动', '直播'], desc: '打造声音节目与直播互动' },
      { role: '版权商务', skills: ['IP', '授权', '合同', '渠道'], desc: '运营内容版权与授权商务' },
      { role: '编剧 AI 应用师', skills: ['AIGC', '分镜', '多模态', '工作流'], desc: '用 AIGC 提效内容创作流程' }
    ]
  },
  {
    id: 'architecture', name: '建筑家居', emoji: '🏗️',
    jobs: [
      { role: '建筑设计师', skills: ['方案', 'BIM', '规范', '效果图'], desc: '完成建筑方案与深化设计' },
      { role: '室内设计总监', skills: ['风格', '软装', '落地', '预算'], desc: '把控室内项目风格与落地' },
      { role: '工程造价师', skills: ['清单', 'BIM算量', '结算', '审价'], desc: '负责项目成本与结算审核' },
      { role: '智慧工地工程师', skills: ['IoT', '视频AI', '安全', '现场'], desc: '部署智慧建造与安全监控' },
      { role: '家居产品经理', skills: ['人体工学', '供应链', '爆品'], desc: '定义家具与智能家居产品' },
      { role: '城市更新顾问', skills: ['旧改', '容积率', '配套', '回迁'], desc: '规划城市更新项目方案' }
    ]
  },
  {
    id: 'agriculture', name: '农业食品', emoji: '🌾',
    jobs: [
      { role: '智慧农业专家', skills: ['IoT', '无人机', '水肥', '平台'], desc: '打造精准农业与监控平台' },
      { role: '育种研究员', skills: ['组培', '基因', '品比', '田间'], desc: '开展作物新品种选育' },
      { role: '种植技术经理', skills: ['茬口', '植保', '测土', '成本'], desc: '指导规模化种植与降本' },
      { role: '冷链物流经理', skills: ['仓储', '温控', '链路', '损耗'], desc: '优化生鲜冷链与损耗管控' },
      { role: '农产品电商', skills: ['溯源', '电商', '产地直发', '基地'], desc: '运营农产品上行电商渠道' },
      { role: '乡村文旅运营', skills: ['民宿', '体验', '合作社', '引流'], desc: '运营乡村文旅与乡村品牌' }
    ]
  },
  {
    id: 'legal', name: '法律合规', emoji: '⚖️',
    jobs: [
      { role: '公司法务', skills: ['合同', '劳动', '诉讼', '知产'], desc: '处理公司法律事务与合同' },
      { role: '合规官', skills: ['政策', '内控', '审计', '培训'], desc: '构建企业合规与内控体系' },
      { role: '知识产权律师', skills: ['专利', '商标', '版权', '维权'], desc: '保护企业知识产权与维权' },
      { role: '数据合规专家', skills: ['数据安全', '个保法', '跨境', '评估'], desc: '保障数据合规与风险评估' },
      { role: '税务筹划师', skills: ['节税', '汇算', '海外架构', '稽查'], desc: '优化企业税务架构与风险' },
      { role: '并购律师', skills: ['尽调', '交易架构', '交割', '反垄断'], desc: '支持并购交易全流程' }
    ]
  },
  {
    id: 'hr', name: '人力资源', emoji: '🧑‍🤝‍🧑',
    jobs: [
      { role: '组织发展专家', skills: ['组织诊断', 'OD', '人才盘点', '结构'], desc: '推动组织变革与效能提升' },
      { role: '招聘专家', skills: ['Sourcing', '面试官', '人才地图', 'offer'], desc: '构建高端人才招聘体系' },
      { role: '绩效薪酬专家', skills: ['OKR', 'KPI', '宽带薪酬', '激励'], desc: '设计绩效与薪酬激励体系' },
      { role: 'HRBP', skills: ['业务伙伴', '文化建设', '员工关系'], desc: '深入业务支持团队成长' },
      { role: '雇主品牌', skills: ['校招', '内容', '雇主价值', '渠道'], desc: '打造雇主品牌与人才吸引' },
      { role: 'EAP 心理顾问', skills: ['心理疏导', '危机干预', '培训'], desc: '支持员工心理健康与关怀' }
    ]
  },
  {
    id: 'logistics', name: '物流供应链', emoji: '🚚',
    jobs: [
      { role: '供应链总监', skills: ['网络', '成本', '协同', '韧性'], desc: '统筹供应链网络与成本' },
      { role: '仓库规划师', skills: ['WMS', '穿梭车', '布局', '拣选'], desc: '设计仓储布局与自动化' },
      { role: '货运统筹', skills: ['干线', '城配', '时效', '拼载'], desc: '优化运输网络与时效' },
      { role: '关务专家', skills: ['报关', 'HS编码', 'AEO', '退税'], desc: '处理进出口关务与合规' },
      { role: '需求预测分析师', skills: ['预测', '安全库存', 'ML', 'S&OP'], desc: '提升需求预测准确率' },
      { role: '最后一公里运营', skills: ['即时配', '骑手', '成本', '体验'], desc: '优化末端配送成本体验' }
    ]
  },
  {
    id: 'design', name: '创意设计', emoji: '🎨',
    jobs: [
      { role: '品牌视觉设计师', skills: ['VI', '插画', '字体', '版式'], desc: '构建品牌视觉识别体系' },
      { role: 'UI/UX 设计师', skills: ['Figma', '交互', '动效', '规范'], desc: '打磨数字产品体验设计' },
      { role: '3D 建模师', skills: ['Blender', '渲染', '贴图', '资产'], desc: '产出高质量 3D 资源' },
      { role: '动效设计师', skills: ['After Effects', 'Lottie', 'MG'], desc: '制作产品动效与影视包装' },
      { role: '工业设计师', skills: ['建模', 'CMF', '开模', '人机'], desc: '定义产品外观与体验' },
      { role: 'AIGC 设计导演', skills: ['Midjourney', 'ComfyUI', '提示词', '工作流'], desc: '用生成式 AI 打造视觉内容' }
    ]
  },
  {
    id: 'data', name: '数据科学', emoji: '🔢',
    jobs: [
      { role: '数据分析师', skills: ['SQL', 'Excel', '可视化', '指标体系'], desc: '支撑业务数据分析与洞察' },
      { role: '数据产品经理', skills: ['埋点', 'BI', '数据资产', '文档'], desc: '构建数据产品与指标体系' },
      { role: '数据治理专家', skills: ['元数据', '血缘', '质量', '标准'], desc: '搭建企业数据治理框架' },
      { role: '数据仓库工程师', skills: ['数仓', 'ETL', '建模', '调度'], desc: '研发数据仓库与可扩展链路' },
      { role: '数据科学家', skills: ['建模', '实验设计', '因果推断', '部署'], desc: '用科学方法解决业务难题' },
      { role: 'BI 可视化专家', skills: ['看板', '下钻', '故事线', '指标'], desc: '打造管理层决策看板' }
    ]
  },
  {
    id: 'security', name: '安全与运维', emoji: '🛡️',
    jobs: [
      { role: '渗透测试专家', skills: ['WEB渗透', '逆向', '红队', '报告'], desc: '发现并修复系统安全漏洞' },
      { role: '安全运营工程师', skills: ['SOC', 'SIEM', '应急', '威胁情报'], desc: '监控并处置安全事件' },
      { role: '云架构师', skills: ['AWS', 'Azure', '高可用', '成本优化'], desc: '设计云基础设施与成本模型' },
      { role: '数据库管理员', skills: ['MySQL', '优化', '备份', '容灾'], desc: '保障数据库稳定与性能' },
      { role: 'SRE 工程师', skills: ['SLO', '发布', '容灾', '监控'], desc: '保障服务可用性与可靠性' },
      { role: '零信任架构师', skills: ['身份', 'IAM', 'SSO', '最小权限'], desc: '构建零信任安全架构' }
    ]
  }
];

function list() {
  return INDUSTRIES.map(x => ({
    id: x.id, name: x.name, emoji: x.emoji,
    jobs: x.jobs.map(j => ({ role: j.role, skills: j.skills.slice(), desc: j.desc }))
  }));
}

function count() {
  return INDUSTRIES.reduce((n, x) => n + x.jobs.length, 0);
}

module.exports = { INDUSTRIES, list, count };