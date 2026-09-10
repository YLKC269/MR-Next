// core/assetgen_presets.js — 旧包 10 条内置角色资产布局预设（生图面板对齐）
// 【角色描述】/【风格】为占位符，点「使用」填入后可替换为具体角色设定
export const PROMPT_PRESETS = [
  {
    "name": "① 标准五格资产板（16:9 无头全身+脸颈）",
    "prompt": "画布：横向16:9；左侧占画面2/3，由三等分竖向全身面板组成；右侧占画面1/3，由上下两等分脸颈面板组成，面板间使用细冷灰分隔线。\n左侧第1格：无头正面躯干，从锁骨上方自然截断至鞋底。头部、下巴和脖子不得出现；截断处只保留完整衣领开口与背景。服装露出的肩部、锁骨、上胸和腹部必须呈现自然肤色与连续皮肤，不得被布料、假高领、灰色留白或额外衣物覆盖。\n左侧第2格：无头严格90度左侧躯干，从锁骨上方自然截断至鞋底。头部、下巴和脖子不得出现；但服装露出的肩部、锁骨、侧胸与腹部必须保留自然皮肤和原有服装结构。\n左侧第3格：严格背面全身，从完整头部、头发至鞋底；完整呈现服装背部结构、下摆与鞋，无多余饰品。\n右侧上格：正脸与脖子特写，五官清晰，表情中性。\n右侧下格：45度左侧脸与脖子特写，发型轮廓完整。\n角色设定：【角色描述：如 黑色不对称绑带上衣配工装长裤的少女，及肩黑发，气质冷冽】。全板为同一角色，服装、发色、肤色、体型完全一致；浅灰无缝纯色背景，均匀柔光无投影，无文字、无水印、无多余道具。"
  },
  {
    "name": "② 21:9 超宽设定卡（特写+三视图+2×3肖像）",
    "prompt": "21:9超宽横版角色完整设定卡，纯白干净棚拍背景。以【角色描述：如 参考图人物或文字描述的角色】为唯一身份锚点：脸型轮廓、下颌线、颧骨、眼型、眉形、鼻梁、嘴唇、年龄气质必须严格一致；发际线、发型结构与发饰必须严格一致。只允许同一个角色，禁止换脸、禁止五官漂移、禁止发型简化或发饰缺失。\n单张合成图，左中右三分区构图，三区统一光影与色彩，柔光棚拍布光，光源方向一致：\n左区（占画面宽度约25%）：人物面部正面超高清特写，头部至胸部肖像构图，头顶发型与发饰完整入画不裁切，眼神平视前方，无表情自然放松。\n中区（占画面宽度约45%）：三张全身站姿图并排排列，人物脚部完整入画，脚下干净柔和投影，三图头顶与脚底同一水平线对齐，人物高度一致，服装配饰鞋履严格对应：全身正面站姿、全身90度侧面站姿（面朝左）、全身背面站姿，均为中性站姿、手臂自然下垂。\n右区（占画面宽度约30%）：2列×3行肖像网格，六格等大，头部至胸部构图，头顶完整入画：左45度侧脸、后脑视图、低头30度、抬头30度、克制微笑、克制生气；每格仅角度与表情变化，脸型骨骼不变形。\n全图无文字、无标签、无logo、无水印；真实皮肤质感，不磨皮不塑料感，8K超清。"
  },
  {
    "name": "③ 16:9 漫剧三视图（左特写+右三视图）",
    "prompt": "16:9横版电影构图，【风格：如 二次元动漫写实 / 电影级写实】，线条干净流畅，色彩质感统一，纯白色极简纯色背景，无任何杂物纹理。\n画面分区布局：画面左侧1/3区域，超大超清人物面部特写，发丝级细节、五官光影、妆容服饰纹路1:1还原；画面右侧2/3区域，横向整齐并排三张人物全身标准站姿三视图，依次为正面全身、左侧面全身、背面全身。\n严格视觉对齐准则：三个视角人物身高、头身比、肩宽体态完全统一；五官位置、脸型轮廓、发型分缝左右无偏差；服装版型、布料褶皱、配饰位置、衣摆垂坠角度跨视角完美契合；人物站姿笔直中立，身体无倾斜、透视无畸变。\n角色设定：【角色描述】。\n画质：8K超高清，线条锐利，上色均匀，光影统一柔和，边缘无模糊锯齿；禁止五官不对称、头身比例失调、特写与全身样貌不符、多余背景与阴影杂乱。"
  },
  {
    "name": "④ 双排七格锁定板（4全身A-pose+3肖像）",
    "prompt": "Create a professional character reference sheet based strictly on the uploaded reference image / 【角色描述】. Use a clean, neutral plain background and present the sheet as a technical model turnaround while matching the exact visual style of the reference (same realism level, rendering approach, texture, color treatment). Arrange the composition into two horizontal rows. Top row: four full-body standing views placed side-by-side in this order: front view, left profile view (facing left), right profile view (facing right), back view. Bottom row: three highly detailed close-up portraits aligned beneath the full-body row in this order: front portrait, left profile portrait (facing left), right profile portrait (facing right). Maintain perfect identity consistency across every panel. Keep the subject in a relaxed A-pose with consistent scale and alignment between views, accurate anatomy, clear silhouette; even spacing and clean panel separation, uniform framing and consistent head height across the full-body lineup and consistent facial scale across the portraits. Lighting consistent across all panels (same direction, intensity, softness), natural controlled shadows, no dramatic mood shifts. Output a crisp, print-ready reference sheet, sharp details. Aspect ratio 16:9. No text, no watermark."
  },
  {
    "name": "⑤ 三格无头转面板（无头正/带头背/胸像特写）",
    "prompt": "基于参考图或【角色描述】生成三格人物资产参考板。横向构图，均分为三个竖向面板，细浅灰分隔线。三个面板为同一人物、同一套服装，脸型、发型、发色、身材比例、服装、配饰严格一致。\n左格：无头正面全身。身体面向镜头，从肩线以下到双脚；双臂自然垂放，双手放松，双脚均匀承重。无头部、无头发，肩线以上不出现任何内容，颈部在喉底以干净利落的水平截断收尾，如无头人台的清晰雕塑边缘，不模糊、不渐隐、不烟雾化、不透明、不血腥、不露出解剖结构；截断面之上只有空白背景。保留正常全身构图间距，肩部上方留足空白。\n中格：带头背面全身。同一人物从正后方拍摄，站姿挺直，头发自然垂落背部，服装背部结构、下摆或裤型与鞋清晰可见，头顶到鞋完整入画。\n右格：锁骨以上胸像特写（身份锁定）。同一人物，从头顶上方到锁骨，面部占画面主体，平视镜头，直视镜头，双唇闭合，表情中性克制，眼、眉、睫毛、唇纹与关键身份特征在特写下清晰。\n三格统一背景：平整均匀的18%中性灰无缝背景，单一色值，无渐变无衰减；无影平光均匀布光，无主光侧、无阴影侧、无轮廓光；背景无投影，脚下零投影，三格光线完全一致。写实照片质感，皮肤细腻毛孔与次表面散射，发丝分明，织物纹理清晰；真实人类摄影感，不塑料、不CG、不过度磨皮。无文字无水印。"
  },
  {
    "name": "⑥ 四格棚拍参考板（4:3 面部遮罩版）",
    "prompt": "Create a clean studio character reference sheet for 【角色描述】. Canvas: landscape 4:3, divided by thick white grid lines into four equal rectangular panels. Neutral medium-gray seamless photography background in every panel, soft even studio lighting, realistic photo quality, no text, no logos, no watermark. Layout: exactly 4 panels. Top-left panel: close-up front-facing head-and-shoulders portrait, face clearly visible, centered, calm neutral expression. Top-right panel: three-view full-body turnaround on the gray background — front view with the face intentionally replaced by a smooth gray oval blank mask, right side profile with the face blanked, back view with hair and outfit visible. Bottom-left panel: close-up left-facing side-profile portrait, head and shoulders composition. Bottom-right panel: single full-body front view standing pose, centered, head cropped off above the neck, emphasizing outfit and body proportions. Keep the same hairstyle, body shape, clothing and shoes consistent across all panels. Minimal fashion model character sheet, accurate human proportions, no extra poses, labels, props, accessories or background objects."
  },
  {
    "name": "⑦ UE5 生产级角色表（多视图+服装面板）",
    "prompt": "Create a complex UE5 MetaHuman style production character sheet for the character described below. Use strict production continuity: the character must remain identical across all views — preserve face identity, body proportions, hairstyle, outfit, accessories, markings, and all asymmetrical left/right details. Use a technical 3D character-reference layout, not a glamour poster: orthographic style body views, clean studio lighting, neutral background, panel borders, callout lines, body landmark labels, surface detail panels, hands/feet reference, hair/groom reference, and costume detail panels. Left and right are always from the character's perspective; never mirror asymmetrical details between views. Separate neutral body documentation (simple readable base outfit) from complex costume documentation (armor, layered garments, props and accessories in dedicated panels). Required views: front view, 3/4 left view, left profile, back view, 3/4 right view, right profile, body measurement and landmark panel, surface detail close-ups, hands and feet close-ups, hair/groom panel, costume detail panel. CHARACTER SUMMARY: 【角色描述：含年龄、体型、脸型五官、发型发色、皮肤、服装盔甲、不对称细节、配饰道具】. Label style: minimal numbered callouts. Style: 【如 UE5 realistic render / stylized anime / dark fantasy】. No watermark."
  },
  {
    "name": "⑧ 竖版3:4三行设定卡（信息色板+三视图+特写）",
    "prompt": "一张专业影视级AI角色设定图（Character Design Sheet），竖版3:4比例，三行分区布局，高级游戏原画设定集风格，【题材风格：如 仙侠/古风/玄幻/科幻】，电影级真实人物，超高清8K，真实皮肤质感，极简排版，浅米白纯色背景，无场景背景，留白充足，干净高级。\n【第一行】左侧为角色半身胸像（占约60%面积），正面朝向镜头：年龄、性别、身份气质、脸型五官、眼睛瞳色、发型发色、肤色神态、服饰材质纹样、配饰武器、整体配色均按角色设定呈现，电影级光影，发丝清晰，布料纹理丰富。右侧为角色信息卡：角色名称、身份设定、性格标签、世界观一句话简介，下方展示Color Palette色彩规范（4-6个圆形色块：主色、辅色、点缀色），现代UI细线边框极简杂志排版。\n【第二行】角色标准三视图：正面、侧面、背面全身，三个人物完全一致的身材比例、脸部特征、发型、服装、配饰，仅视角不同，站姿自然，纯色背景，展示完整服装结构和角色比例。\n【第三行】局部特写三格：面部五官特写、发饰或头冠特写、武器或服装细节特写，重点展示眼睛妆容、刺绣纹样、金属珠宝、布料皮革质感，细边框分隔。\n角色设定：【角色描述：如 青衣女侠，乌黑长发束高马尾，白色广袖襦裙外罩淡青披风，腰悬长剑】。整体构图对称，排版精致，AAA游戏角色设定板质感，超写实。"
  },
  {
    "name": "⑨ 头部转面表情表（2×3 转面+表情）",
    "prompt": "角色头部转面与表情参考表，2列×3行六格等大网格，细浅灰分隔线，每格头部至胸部竖向构图，头顶发型与发饰完整入画不裁切，六格头部大小与构图框架统一。\n第一行左：头部正面朝左45度，无表情；第一行右：头部正背面视图（后脑发型完整）。\n第二行左：正面低头30度，眼神朝下，无表情；第二行右：正面抬头30度，眼神朝上，无表情，头顶发型仍完整入画。\n第三行左：正面开心表情，嘴角上扬，笑意克制，不露齿或微露齿；第三行右：正面生气表情，眉头微皱，眼神收紧，情绪克制，不变形不狰狞。\n六格为同一角色：脸型轮廓、五官比例、发型发色、发饰、肤色严格一致，仅角度与表情微变化，不改变骨骼与脸型结构；服装领口与配饰六格统一。\n角色设定：【角色描述】。纯白极简背景，统一柔光棚拍光线，真实皮肤质感，8K超清，无文字无水印。"
  },
  {
    "name": "⑩ 服装分层道具拆解板（穿脱分层+Callout）",    "prompt": "角色服装分层与道具拆解资产板，横版16:9，白色背景，细线分格与callout引线（标注框留空不写字），专业概念设计拆解图排版。\n中央：角色全身正面站姿，完整穿着所有服装与配饰，展示整体造型轮廓。\n左侧两格：同一角色的服装分层状态——外层脱去后的中层穿着形态；再脱去中层后的内层/基础层穿着形态；每层服装结构、配色与整体造型严格对应，不得新增或丢失细节。\n右侧三格：关键配饰与道具的独立特写（如【头盔/背包/武器/护目镜/腰包等，按角色设定选择三项】），白底隔离展示，材质细节清晰。\n角色设定：【角色描述】。\n全板同一角色，统一柔光布光，无背景杂物，无文字（标注框留空），无水印，4K高清细节。"
  },
  // ============ 分镜九宫格故事板（3×3）============
  // 工程要点（按 3×3 严格等分推导）：单格宽高比 ≡ 整图宽高比。
  //   · 整图 1:1   → 每格 1:1（适合方图/通用）
  //   · 整图 9:16  → 每格 9:16（竖屏短剧，切格即 i2v 首帧，无需裁切）
  //   · 整图 16:9  → 每格 16:9（横屏）
  // i2v 首帧要求：单格短边 > 300px。所以整图 9:16 用 1152×2048（单格 384×683）。
  // 九格叙事推进（写入提示词，保证每格都有内容）：建立环境→引入主角→触发事件→冲突升级→
  // 转折→情绪特写→行动推进→危机反转→收束钩子；景别递进 大远景→全景→中景→中近景→近景→特写→中景→仰角中景→远景/特写。
  {
    "name": "⑪ 分镜九宫格·写实电影感（1:1 · 每格 512×512）",
    "w": 1536,
    "h": 1536,
    "prompt": "Cinematic 3x3 storyboard contact sheet: nine equal panels in a strict 3 by 3 grid, equal panel size, perfectly aligned rows and columns, thin uniform light-grey 2px separator lines. Same character in every panel: 【角色描述：如 30岁女性，黑色齐耳短发，杏眼，米色风衣】, identical face, same hairstyle and same outfit in all nine panels; same location: 【场景：如 夜晚霓虹雨街】; consistent lighting and color grading across all panels. Cinematic film still, shot on ARRI Alexa, 35mm lens, shallow depth of field, subtle film grain, photorealistic, natural skin texture, 8k detail. Panels read left to right, top to bottom: 1 wide establishing shot of the environment, 2 full-body long shot of the character entering, 3 medium waist-up shot, 4 over-the-shoulder shot, 5 close-up of the face, 6 extreme close-up of the eyes, 7 low-angle shot, 8 high-angle shot, 9 wide closing shot. Each panel is a complete well-composed frame with the subject fully inside the frame and the head never cropped. Keep every panel clean: absolutely no text, letters, numbers, captions, subtitles, speech bubbles, arrows, timestamps, watermarks, logos or UI overlays anywhere; no thick borders, no ornate frames, no uneven or misaligned panels, no diagonal or tilted grid, no merged panels."
  },
  {
    "name": "⑫ 分镜九宫格·日式动漫（1:1 · 每格 512×512）",
    "w": 1536,
    "h": 1536,
    "prompt": "Anime 3x3 storyboard sheet: strict 3 by 3 grid, nine equal panels, equal panel size, perfectly aligned rows and columns, thin light-grey separator lines. Same heroine in all nine panels: 【角色描述：如 高中生少女，黑色长直发，水手服】, identical character design, same face, same hairstyle, same outfit; same background: 【场景：如 黄昏的郊外车站站台】. Japanese anime key visual, cel shading, clean crisp line art, vibrant colors, soft rim light, 【风格：如 新海诚式光效】, consistent color grading across all panels. Panels read left to right, top to bottom: 1 wide establishing shot, 2 full-body walking shot, 3 medium shot, 4 over-the-shoulder shot, 5 close-up of the face, 6 extreme close-up of the eyes, 7 low-angle shot, 8 high-angle shot, 9 wide closing shot. Each panel is a complete frame with the subject fully inside the frame and the head never cropped. Keep every panel clean: absolutely no text, letters, numbers, captions, speech bubbles, watermarks, logos or UI overlays; no thick borders, no uneven or misaligned panels, no diagonal or tilted grid."
  },
  {
    "name": "⑬ 分镜九宫格·竖屏短剧（9:16 · 切格即 i2v 首帧）",
    "w": 1152,
    "h": 2048,
    "prompt": "Vertical 9:16 storyboard sheet: strict 3 by 3 grid, nine equal panels, each panel is itself a vertical 9:16 composition, equal panel size, perfectly aligned rows and columns, thin uniform light-grey separator lines. Same character in every panel: 【角色描述：如 28岁女性，及肩黑发，米色羊毛大衣，神情平静】，identical face, same hair, same outfit in all nine panels; same setting: 【场景：如 昏暗的现代公寓客厅】. Vertical-drama framing: center-weighted composition, medium shots and close-ups dominant, shallow depth of field, strong rim light, cinematic teal-and-orange grading consistent across all panels, photorealistic, high detail. Panels read left to right, top to bottom: 1 wide establishing shot of the room, 2 medium shot entering the room, 3 close-up of a letter on the table, 4 medium close-up picking it up, 5 extreme close-up of her eyes, 6 over-the-shoulder shot, 7 low-angle shot, 8 high-angle shot, 9 wide closing shot. Each panel is a complete vertical frame with the subject fully inside the frame, head never cropped, generous headroom and looking space so the panel can serve as a first frame for image-to-video. Keep every panel clean: absolutely no text, letters, numbers, captions, subtitles, speech bubbles, arrows, timestamps, watermarks, logos or UI overlays; no thick borders, no uneven or misaligned panels, no tilted grid, no horizontal letterbox bars."
  },
  {
    "name": "⑭ 分镜九宫格·横屏 16:9（每格 853×480）",
    "w": 2560,
    "h": 1440,
    "prompt": "Cinematic 16:9 storyboard contact sheet: each panel is a 16:9 widescreen frame, arranged in a strict 3 by 3 grid of nine equal panels, perfectly aligned rows and columns, thin uniform light-grey separator lines. Same character in every panel: 【角色描述】，identical face, same hairstyle, same outfit in all nine panels; same location: 【场景】; consistent lighting and color grading across all panels. Anamorphic widescreen cinematography, film grain, photorealistic, high detail. Panels read left to right, top to bottom: 1 wide establishing shot, 2 long shot of the character, 3 medium shot, 4 over-the-shoulder shot, 5 close-up, 6 extreme close-up, 7 low-angle shot, 8 high-angle shot, 9 wide closing shot. Each panel is a complete 16:9 frame with the subject fully inside the frame and the head never cropped. Keep every panel clean: absolutely no text, letters, numbers, captions, subtitles, watermarks, logos or UI overlays; no thick borders, no uneven or misaligned panels, no vertical framing, no letterbox inside panels."
  }
];
