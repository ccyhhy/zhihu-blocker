/** 只确定直接作者、回答标识及用户悬浮卡片，不做文字规则匹配。 */
const ZBScanner = (() => {
  const UNITS = '.AnswerItem, .ArticleItem, .CommentItem, .CommentItemV2, [data-comment-id], .ContentItem, .MemberList-item, .ProfileHeader, .Post-Main, article';
  const BODIES = '.RichContent-inner, .AnswerItem-content, .ArticleItem-content, .Post-RichTextContainer, .CommentContent, .CommentItem-content, .CommentItemV2-content';
  const CANDIDATES = UNITS + ', [data-id]';
  const clean = value => String(value || '').replace(/\s+/g,' ').trim();
  function modernComment(unit) {
    if (unit.matches(UNITS)) return false;
    return /^\d+$/.test(unit.getAttribute('data-id') || '') && [...unit.querySelectorAll('.CommentContent')].some(body => body.closest('[data-id]') === unit);
  }
  const isUnit = unit => !unit.closest('[data-zb-ui]') && (unit.matches(UNITS) || modernComment(unit));
  function closestUnit(element) {
    let unit = element?.closest?.(CANDIDATES);
    while (unit && !isUnit(unit)) unit = unit.parentElement?.closest(CANDIDATES);
    return unit || null;
  }
  function collectUnits(roots = [document]) {
    const units = new Set();
    for (const root of roots) {
      if (root.nodeType === Node.ELEMENT_NODE) { const owner = closestUnit(root); if (owner) units.add(owner); }
      root.querySelectorAll?.(CANDIDATES).forEach(unit => { if (isUnit(unit)) units.add(unit); });
    }
    return units;
  }
  function tokenFromUrl(value) {
    try { const url = new URL(value,location.href); return /(^|\.)zhihu\.com$/.test(url.hostname) && /^https?:$/.test(url.protocol) ? url.pathname.match(/^\/people\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || null : null; } catch { return null; }
  }
  const isComment = unit => unit.matches('.CommentItem, .CommentItemV2, [data-comment-id]') || modernComment(unit);
  function authorOf(unit) {
    if (unit.matches('.ProfileHeader')) {
      const token = extractProfileTokenFromUrl();
      return token ? {urlToken:token,name:clean(unit.querySelector('.ProfileHeader-name')?.textContent || token).slice(0,80)} : null;
    }
    const links = [...unit.querySelectorAll('a[href*="/people/"]')].filter(link => closestUnit(link) === unit && closestUnit(link.closest(BODIES)) !== unit);
    const modern = modernComment(unit), avatars = modern ? links.filter(link => link.querySelector('img.Avatar')) : [];
    const avatarTokens = new Set(avatars.map(link => tokenFromUrl(link.href)).filter(Boolean));
    if (modern && avatarTokens.size !== 1) return null;
    const avatarToken = [...avatarTokens][0];
    const preferred = modern ? links.find(link => tokenFromUrl(link.href) === avatarToken && clean(link.textContent)) || avatars[0] :
      links.find(link => link.closest('.AuthorInfo, .Post-Author, .CommentItem-meta, .CommentItemV2-meta')) || links.find(link => link.closest('.UserLink')) || links[0];
    const token = preferred ? tokenFromUrl(preferred.href) : unit.matches('.ProfileHeader') ? extractProfileTokenFromUrl() : null;
    if (!token || ['undefined','null'].includes(token)) return null;
    if (!modern && !preferred?.closest('.AuthorInfo, .Post-Author, .CommentItem-meta, .CommentItemV2-meta, .UserLink') && new Set(links.map(link => tokenFromUrl(link.href)).filter(Boolean)).size > 1) return null;
    return {urlToken:token,name:clean(preferred?.textContent || preferred?.querySelector('img.Avatar')?.alt || unit.querySelector('.ProfileHeader-name')?.textContent || token).slice(0,80)};
  }
  function answerIdForUnit(unit) {
    if (isComment(unit) || unit.matches('.ArticleItem, .Post-Main, article')) return null;
    const explicit = unit.getAttribute('data-answer-id') || unit.getAttribute('data-answerid') || (unit.matches('.AnswerItem') ? unit.getAttribute('data-id') : '');
    if (/^\d+$/.test(explicit || '')) return explicit;
    for (const attr of ['data-zop','data-za-extra-module']) {
      try { const data = JSON.parse(unit.getAttribute(attr)); const id = data?.answerId || data?.answer_id || (data?.type === 'answer' || data?.itemType === 'answer' ? data.itemId || data.id : null); if (/^\d+$/.test(String(id || ''))) return String(id); } catch { /* 缺少明确标识时不猜测。 */ }
    }
    for (const link of unit.querySelectorAll('a[href*="/answer/"], [itemid*="/answer/"]')) if (closestUnit(link) === unit && !link.closest(BODIES)) {
      const id = (link.getAttribute('href') || link.getAttribute('itemid') || '').match(/\/answer\/(\d+)/)?.[1]; if (id) return id;
    }
    const fromUrl = location.pathname.match(/\/answer\/(\d+)/)?.[1];
    return unit.matches('.AnswerItem') && document.querySelector('.AnswerItem') === unit ? fromUrl || null : null;
  }
  function extractAnswerIdsFromPage() {
    const answers = new Map();
    for (const unit of collectUnits()) { const answerId = answerIdForUnit(unit); if (answerId && !answers.has(answerId)) answers.set(answerId,{answerId,author:authorOf(unit)?.name || ''}); }
    return [...answers.values()];
  }
  const extractProfileTokenFromUrl = () => location.pathname.match(/^\/people\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || null;
  function detectPageType() {
    if (extractProfileTokenFromUrl()) return 'profile';
    if (/\/answer\/\d+/.test(location.pathname)) return 'answer';
    if (/^\/question\/\d+/.test(location.pathname)) return 'question';
    if (location.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+/.test(location.pathname)) return 'article';
    return 'feed';
  }
  function hoverContext(buttons) {
    let root = buttons.closest('.HoverCard, .UserHoverCard, .Popover-content');
    if (!root) {
      root = buttons.parentElement;
      for (let i=0;i<4 && root?.parentElement !== document.body && !root?.querySelector('.UserLink-link');i++) root = root?.parentElement;
    }
    if (!root || root === document.body) return null;
    const links = [...root.querySelectorAll('.UserLink-link[href*="/people/"], .HoverCard-title a[href*="/people/"]')];
    const tokens = new Set(links.map(link => tokenFromUrl(link.href)).filter(Boolean));
    if (tokens.size !== 1) return null;
    const token = [...tokens][0], link = links.find(link => tokenFromUrl(link.href) === token);
    return {root,user:{urlToken:token,name:clean(link.textContent || token).slice(0,80)}};
  }
  function shieldable(unit) {
    return !unit.matches('.ProfileHeader, .MemberList-item, [data-za-detail-view-path-module="UserItem"]') &&
      (isComment(unit) || unit.matches('.AnswerItem, .ArticleItem, .Post-Main, article') || !!unit.querySelector('.RichContent-inner'));
  }
  return {collectUnits,closestUnit,authorOf,isComment,answerIdForUnit,extractAnswerIdsFromPage,extractProfileTokenFromUrl,detectPageType,hoverContext,shieldable};
})();
