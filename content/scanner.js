/** 按内容单元确定直接作者，排除嵌套评论的作者和正文。 */
const ZBScanner = (() => {
  const UNITS = '.AnswerItem, .ArticleItem, .CommentItem, .CommentItemV2, [data-comment-id], .ContentItem, .MemberList-item, .ProfileHeader, .Post-Main, article';
  const BODIES = '.RichContent-inner, .AnswerItem-content, .ArticleItem-content, .Post-RichTextContainer, .CommentContent, .CommentItem-content, .CommentItemV2-content, [class*="RichText"]';
  const CANDIDATES = UNITS + ', [data-id]';
  // 新版评论使用数字 data-id；正文必须直接属于它，不能把外层容器当评论。
  function modernComment(unit) {
    if (unit.matches(UNITS)) return false;
    return /^\d+$/.test(unit.getAttribute('data-id') || '') &&
      [...unit.querySelectorAll('.CommentContent')].some(body => body.closest('[data-id]') === unit);
  }
  const isUnit = unit => unit.matches(UNITS) || modernComment(unit);
  function closestUnit(element) {
    let unit = element?.closest?.(CANDIDATES);
    while (unit && !isUnit(unit)) unit = unit.parentElement?.closest(CANDIDATES);
    return unit || null;
  }
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  function detectPageType() {
    const p = location.pathname;
    if (/^\/people\/[^/]+\/followers\/?$/.test(p)) return 'followers';
    if (/^\/people\/[^/]+\/(?:following|followees)\/?$/.test(p)) return 'followees';
    if (/^\/(?:question\/\d+\/)?answer\/\d+/.test(p)) return 'answer';
    if (/^\/question\/\d+/.test(p)) return 'question';
    if (/^\/people\/[^/]+\/?$/.test(p)) return 'profile';
    if (location.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+/.test(p)) return 'article';
    return 'feed';
  }
  function extractUrlTokenFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/(^|\.)zhihu\.com$/.test(url.hostname)) return null;
      return url.pathname.match(/^\/people\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || null;
    } catch { return null; }
  }
  const extractProfileTokenFromUrl = () => location.pathname.match(/^\/people\/([^/]+)/)?.[1] || null;
  const extractAnswerIdFromUrl = () => location.pathname.match(/\/answer\/(\d+)/)?.[1] || null;
  function listUnavailable() {
    return detectPageType() === 'followees' && /由于对方已设置[\s\S]*关注的人不可见/.test(document.querySelector('main')?.innerText || '') ?
      '对方已设置关注名单不可见，无法处理此名单。' : '';
  }
  function metadataId(text) {
    try {
      const data = JSON.parse(text);
      if (data?.type === 'answer' || data?.itemType === 'answer') return String(data.itemId || data.id || '');
      if (data?.answerId || data?.answer_id) return String(data.answerId || data.answer_id);
    } catch { /* 不明属性只接受明确的 answer URL。 */ }
    return String(text || '').match(/\/answer\/(\d+)/)?.[1] || null;
  }
  function extractAnswerIdsFromPage() {
    const answers = new Map();
    function add(id, element) {
      if (!/^\d+$/.test(String(id || '')) || answers.has(String(id))) return;
      const unit = closestUnit(element) || element;
      const user = unit ? extractUsers([unit])[0] : null;
      answers.set(String(id), { answerId: String(id), author: user?.name || '', excerpt: clean(user?.context.answer).slice(0, 48) });
    }
    add(extractAnswerIdFromUrl(), document.querySelector('.AnswerItem'));
    document.querySelectorAll('a[href*="/answer/"], [data-answer-id], [data-answerid], [data-zop], [data-za-extra-module], .AnswerItem[data-id], [itemid*="/answer/"]').forEach(el => {
      if (el.matches('a') && el.closest(BODIES)) return;
      add(el.getAttribute('data-answer-id') || el.getAttribute('data-answerid'), el);
      if (el.matches('.AnswerItem')) add(el.getAttribute('data-id'), el);
      for (const key of ['href', 'itemid', 'data-zop', 'data-za-extra-module']) add(metadataId(el.getAttribute(key)), el);
    });
    return [...answers.values()];
  }
  const extractAnswerIdFromPage = () => extractAnswerIdFromUrl() || extractAnswerIdsFromPage()[0]?.answerId || null;
  function collectUnits(roots = [document]) {
    const units = new Set();
    for (const root of roots) {
      if (root.nodeType === Node.ELEMENT_NODE) {
        const owner = closestUnit(root); if (owner) units.add(owner);
      }
      root.querySelectorAll?.(CANDIDATES).forEach(unit => { if (isUnit(unit)) units.add(unit); });
    }
    return units;
  }
  function ownNodes(unit, selector) {
    return [...unit.querySelectorAll(selector)].filter(el => closestUnit(el) === unit);
  }
  function ownText(element, unit) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node !== unit && (node.matches('script, style') || isUnit(node))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const text = [];
    while (walker.nextNode()) text.push(walker.currentNode.textContent);
    return clean(text.join(' '));
  }
  function kind(unit) {
    if (unit.matches('.CommentItem, .CommentItemV2, [data-comment-id]') || modernComment(unit)) return 'comment';
    if (unit.matches('.ArticleItem, .Post-Main, article') && (unit.matches('.ArticleItem') || detectPageType() === 'article')) return 'article';
    if (unit.matches('.AnswerItem')) return 'answer';
    try {
      const type = JSON.parse(unit.getAttribute('data-zop') || '{}').type;
      if (['answer', 'article'].includes(type)) return type;
    } catch { /* 不按不明内容类型执行正文匹配。 */ }
    return null;
  }
  function extractUsers(roots = [document]) {
    const users = new Map();
    const units = new Set();
    for (const root of roots) {
      if (root.nodeType === Node.ELEMENT_NODE && isUnit(root)) units.add(root);
      else for (const unit of collectUnits([root])) units.add(unit);
    }
    for (const unit of units) {
      const links = ownNodes(unit, 'a[href*="/people/"]').filter(link => closestUnit(link.closest(BODIES)) !== unit);
      const authors = '.AuthorInfo, .Post-Author, .CommentItem-meta, .CommentItemV2-meta, .UserLink';
      const modern = modernComment(unit);
      const avatars = modern ? links.filter(link => link.querySelector('img.Avatar')) : [];
      const avatarTokens = new Set(avatars.map(link => extractUrlTokenFromUrl(link.href)).filter(Boolean));
      // 回复标题还会链接被回复者；用头像与同标识的姓名链接确认直接作者。
      if (modern && avatarTokens.size !== 1) continue;
      const avatarToken = [...avatarTokens][0];
      const preferred = modern ? links.find(link => extractUrlTokenFromUrl(link.href) === avatarToken && clean(link.textContent)) || avatars[0] :
        links.find(link => link.closest('.AuthorInfo, .Post-Author, .CommentItem-meta, .CommentItemV2-meta')) || links.find(link => link.closest('.UserLink')) || links[0];
      const token = preferred ? extractUrlTokenFromUrl(preferred.href) : unit.matches('.ProfileHeader') ? extractProfileTokenFromUrl() : null;
      if (!token || ['undefined', 'null'].includes(token)) continue;
      if (!modern && !preferred?.closest(authors) && new Set(links.map(link => extractUrlTokenFromUrl(link.href)).filter(Boolean)).size > 1) continue;
      const name = clean(preferred?.textContent || preferred?.querySelector('img.Avatar')?.alt);
      const user = users.get(token) || { urlToken: token, name, context: { bio: '', comment: '', answer: '', article: '' }, contents: [] };
      if (!user.name) user.name = name;
      const source = kind(unit), bodies = ownNodes(unit, BODIES);
      const topBodies = bodies.filter(el => !bodies.some(parent => parent !== el && parent.contains(el)));
      const body = topBodies.map(el => ownText(el, unit)).filter(Boolean).join('\n');
      const bio = ownNodes(unit, '.Bio, .zhihu-signature, .MemberItem-headline, .ProfileHeader-headline, .AuthorInfo-badgeText, .ContentItem[data-za-detail-view-path-module="UserItem"] .ContentItem-meta .ztext, [class*="Signature"]').map(el => ownText(el, unit)).join('\n');
      for (const [field, text] of [['bio', bio], [source, body]]) {
        if (!field || !text) continue;
        user.contents.push({ source: field, text }); user.context[field] += (user.context[field] ? '\n' : '') + text;
      }
      users.set(token, user);
    }
    return [...users.values()];
  }
  function matchUsers(users, rules, whitelist = []) {
    const allowed = new Set(whitelist);
    return users.filter(user => {
      if (allowed.has(user.urlToken)) return false;
      const matches = [], contents = user.contents || Object.entries(user.context).map(([source, text]) => ({ source, text }));
      for (const rule of rules) {
        const keyword = clean(rule.keyword).toLowerCase();
        if (!keyword || !Array.isArray(rule.sources)) continue;
        for (const { source, text } of contents) {
          if (!rule.sources.includes(source)) continue;
          const lower = text.toLowerCase(), index = lower.indexOf(keyword);
          if (index < 0 || (rule.exclude || []).some(word => word && lower.includes(word.toLowerCase()))) continue;
          matches.push({ rule, source, evidence: text.slice(Math.max(0, index - 40), index + keyword.length + 70) }); break;
        }
      }
      user.matchedRules = matches; return matches.length > 0;
    });
  }
  return { detectPageType, extractUrlTokenFromUrl, extractProfileTokenFromUrl, extractAnswerIdFromUrl,
    extractAnswerIdFromPage, extractAnswerIdsFromPage, collectUnits, closestUnit, listUnavailable, extractUsers, matchUsers };
})();
