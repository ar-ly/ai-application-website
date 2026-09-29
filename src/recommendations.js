// 空会话推荐 prompt：内置模板池 + 根据用户历史会话标题推断偏好，加权随机。
// 每个推荐：{ icon, title, desc, prompt, cat }

const POOL = [
  // ---------- 小游戏 ----------
  {
    icon: '🐍',
    title: '贪吃蛇小游戏',
    desc: '方向键控制，吃果实变长',
    prompt: '生成一个贪吃蛇小游戏：用方向键控制小蛇吃果实变长，撞墙或撞到自己则结束，带得分、最高分和开始/暂停按钮',
    cat: 'game',
  },
  {
    icon: '🧩',
    title: '俄罗斯方块',
    desc: '经典下落消除',
    prompt: '生成一个俄罗斯方块游戏：方块自动下落、可旋转和左右移动，填满一行即消除得分，带等级加速和游戏结束判定',
    cat: 'game',
  },
  {
    icon: '🎴',
    title: '记忆翻牌',
    desc: '翻牌配对，考验记忆力',
    prompt: '生成一个记忆翻牌小游戏：若干对背面朝上的卡片，点击翻开两张，相同则消除，记录翻牌次数和用时',
    cat: 'game',
  },
  {
    icon: '⭕',
    title: '井字棋',
    desc: '人机对战三连棋',
    prompt: '生成一个井字棋游戏：玩家与电脑轮流落子，先连成三子者获胜，带胜负判定和重新开始按钮',
    cat: 'game',
  },
  {
    icon: '🔢',
    title: '数字华容道',
    desc: '滑动数字排好顺序',
    prompt: '生成一个数字华容道小游戏：4x4 数字方块打乱后通过滑动复原成 1-15 顺序，记录步数和用时',
    cat: 'game',
  },
  {
    icon: '🎯',
    title: '反应速度测试',
    desc: '测测你的反应毫秒数',
    prompt: '生成一个反应速度测试应用：等待页面变绿后尽快点击，显示反应毫秒数并统计多次平均成绩',
    cat: 'game',
  },
  {
    icon: '✊',
    title: '石头剪刀布',
    desc: '和电脑来一局',
    prompt: '生成一个石头剪刀布游戏：玩家出拳，电脑随机出拳，显示胜负、比分累计和动画效果',
    cat: 'game',
  },
  {
    icon: '🎲',
    title: '骰子抽奖机',
    desc: '转盘或骰子决定选择',
    prompt: '生成一个抽奖转盘应用：可以自定义若干选项，点击开始后转盘旋转，停在随机选项上并弹出结果',
    cat: 'game',
  },

  // ---------- 实用工具 ----------
  {
    icon: '🧮',
    title: '科学计算器',
    desc: '支持四则与常用函数',
    prompt: '生成一个计算器应用：支持四则运算、退格、清空和键盘输入，界面简洁，带历史记录',
    cat: 'tool',
  },
  {
    icon: '🍅',
    title: '番茄钟',
    desc: '专注 25 分钟',
    prompt: '生成一个番茄钟应用：25 分钟专注倒计时加 5 分钟休息，可开始/暂停/重置，完成后提醒，统计今日完成的番茄数',
    cat: 'tool',
  },
  {
    icon: '✅',
    title: '待办清单',
    desc: '勾选完成与分类筛选',
    prompt: '生成一个待办清单应用：可以添加、勾选完成、删除任务，支持全部/未完成/已完成筛选，数据保存在浏览器本地',
    cat: 'tool',
  },
  {
    icon: '📝',
    title: '便签备忘录',
    desc: '随手记录，自动保存',
    prompt: '生成一个便签备忘录应用：可以新建多条彩色便签、编辑和删除，内容自动保存在浏览器本地',
    cat: 'tool',
  },
  {
    icon: '⏰',
    title: '倒计时器',
    desc: '设定分钟数提醒',
    prompt: '生成一个倒计时器应用：可设置任意分钟数，开始倒计时，时间到后播放提示音并弹出提醒',
    cat: 'tool',
  },
  {
    icon: '💱',
    title: '单位换算器',
    desc: '长度、重量、温度',
    prompt: '生成一个单位换算器应用：支持长度、重量、温度等常用单位之间的互相换算，输入时实时转换',
    cat: 'tool',
  },
  {
    icon: '🗓️',
    title: '习惯打卡表',
    desc: '每日打卡连续天数',
    prompt: '生成一个习惯打卡应用：可以添加习惯、每天点击打卡，显示连续天数和最近 30 天的打卡日历',
    cat: 'tool',
  },
  {
    icon: '🔐',
    title: '密码生成器',
    desc: '随机强密码一键复制',
    prompt: '生成一个密码生成器应用：可选择长度和是否包含数字、符号、大写字母，生成随机密码并一键复制',
    cat: 'tool',
  },

  // ---------- 页面/展示 ----------
  {
    icon: '👤',
    title: '个人主页',
    desc: '介绍自己的名片页',
    prompt: '生成一个精美的个人主页：包含头像、姓名、个人简介、技能标签和联系方式按钮，整体现代简洁',
    cat: 'page',
  },
  {
    icon: '🍜',
    title: '餐厅菜单页',
    desc: '带分类的菜单展示',
    prompt: '生成一个餐厅菜单展示页：顶部店名和简介，菜品按分类分组展示，每道菜有名称、描述和价格，卡片式排版',
    cat: 'page',
  },
  {
    icon: '🎂',
    title: '生日祝福页',
    desc: '带动画的惊喜贺卡',
    prompt: '生成一个生日祝福网页：打开有彩带和蛋糕动画，显示祝福语，再放一个可点击的惊喜按钮',
    cat: 'page',
  },
  {
    icon: '📊',
    title: '数据仪表盘',
    desc: '卡片加图表展示',
    prompt: '生成一个数据仪表盘页面：顶部几个关键指标卡片，下方用 CSS 实现柱状图和环形图展示示例数据',
    cat: 'page',
  },
  {
    icon: '🌤️',
    title: '天气卡片',
    desc: '一周天气预报样式',
    prompt: '生成一个天气展示页面：一张大卡片显示当前温度和天气状况，下方一排未来五天的天气预报小卡片',
    cat: 'page',
  },
  {
    icon: '💍',
    title: '婚礼邀请函',
    desc: '浪漫的电子请柬',
    prompt: '生成一个婚礼邀请函网页：包含新人名字、婚礼时间地点、倒计时和 RSVP 回复区，风格温馨浪漫',
    cat: 'page',
  },

  // ---------- 趣味互动 ----------
  {
    icon: '🔮',
    title: '今日运势',
    desc: '抽签看看今日运气',
    prompt: '生成一个今日运势抽签应用：点击按钮抽取今日运势，显示大吉/中吉等签文、幸运色和幸运数字，带翻签动画',
    cat: 'fun',
  },
  {
    icon: '🌈',
    title: '色彩调色盘',
    desc: '自由调色并复制色值',
    prompt: '生成一个色彩调色盘应用：拖动滑块调节颜色，实时显示 HEX 和 RGB 值并一键复制，自动生成一组协调配色',
    cat: 'fun',
  },
  {
    icon: '💬',
    title: '语录生成器',
    desc: '随机一句励志语录',
    prompt: '生成一个随机语录生成器：点击按钮随机展示一条励志语录，配有背景配色变化，可以收藏喜欢的句子',
    cat: 'fun',
  },
]

const CATS = ['game', 'tool', 'page', 'fun']

// 根据历史标题推断各类别偏好权重
function inferWeights(titles) {
  const weights = { game: 1, tool: 1, page: 1, fun: 1 }
  const text = (titles || []).join(' ')
  const rules = [
    [/游戏|2048|贪吃蛇|俄罗斯|方块|棋|消除|华容道|翻牌|骰子/, 'game'],
    [/计算器|时钟|番茄|清单|待办|备忘|计时|换算|打卡|密码|工具/, 'tool'],
    [/主页|菜单|邀请|贺卡|仪表盘|海报|页面|网站|简历/, 'page'],
    [/运势|签|语录|测试|趣味|调色/, 'fun'],
  ]
  for (const [re, cat] of rules) {
    if (re.test(text)) weights[cat] += 2
  }
  return weights
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 挑选推荐 prompt（循环不耗尽）。
 * @param {string[]} titles 用户已有会话标题（用于习惯推断与去重）
 * @param {number} count 返回条数
 * @param {string[]} excludeTitles 本轮已展示过的标题（“换一批”时避免重复）
 * @returns {{ items: object[], cycled: boolean }} cycled=true 表示已展示完一轮、从头循环
 */
export function pickRecommendations(titles = [], count = 4, excludeTitles = []) {
  const weights = inferWeights(titles)

  // 已生成过（标题语义近似）的模板不再推荐，避免重复
  const used = (titles || []).join(' ')
  const base = POOL.filter(
    (item) =>
      !used.includes(item.title.slice(0, 2)) &&
      !used.includes(item.title),
  )
  const safeBase = base.length >= count ? base : POOL.slice()

  const excluded = new Set(excludeTitles)
  let pool = safeBase.filter((i) => !excluded.has(i.title))
  let cycled = false
  // 本轮未展示的不够了 → 一轮循环完毕，从头开始（不会返回空数组）
  if (pool.length < count) {
    cycled = true
    pool = safeBase.slice()
  }

  // 按权重分组，优先从偏好类别抽取，其余类别补足，保证多样性
  const byCat = Object.fromEntries(
    CATS.map((c) => [c, shuffle(pool.filter((i) => i.cat === c))]),
  )
  const result = []
  const orderedCats = shuffle(CATS).sort((a, b) => weights[b] - weights[a])

  // 先从权重最高的类别取 2 条
  let first = 0
  while (result.length < Math.min(2, count) && first < orderedCats.length) {
    const c = orderedCats[first]
    if (byCat[c].length) result.push(byCat[c].pop())
    else first++
  }
  // 再跨类别轮询补足
  let guard = 0
  while (result.length < count && guard++ < 50) {
    for (const c of orderedCats) {
      if (byCat[c].length && result.length < count) result.push(byCat[c].pop())
    }
    if (orderedCats.every((c) => !byCat[c].length)) break
  }
  return { items: result, cycled }
}
