/**
 * 页面扫描器 — 页面类型检测、用户信息提取、关键词匹配
 */
const ZBScanner = (() => {
  // ── 页面类型检测 ────────────────────────────
  function detectPageType() {
    const path = location.pathname;

    if (/^\/people\/[^/]+\/followers/.test(path)) return 'followers';
    if (/^\/people\/[^/]+\/followees/.test(path)) return 'followees';
    if (/^\/question\/\d+\/answer\/\d+/.test(path)) return 'answer';
    if (/^\/question\/\d+/.test(path)) return 'question';
    if (/^\/people\/[^/]+\/?$/.test(path)) return 'profile';
    if (/^\/\d+/.test(path) && location.hostname.includes('zhuanlan')) return 'article';

    // 通用：首页 feed、搜索结果等
    return 'feed';
  }

  /**
   * 从 URL 提取用户的 url_token
   */
  function extractUrlTokenFromUrl(url) {
    const m = url.match(/\/people\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  /**
   * 从当前 URL 提取 answer_id
   */
  function extractAnswerIdFromUrl() {
    const m = location.pathname.match(/\/answer\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractAnswerIdFromPage() {
    return extractAnswerIdFromUrl() || extractAnswerIdsFromPage()[0]?.answerId || null;
  }

  function extractAnswerIdsFromPage() {
    const answers = [];
    const seen = new Set();

    function addAnswer(answerId, sourceEl) {
      if (!/^\d+$/.test(String(answerId || '')) || seen.has(answerId)) return;
      seen.add(answerId);
      const container = findAnswerContainer(sourceEl);
      const author = cleanText(container?.querySelector?.('a[href*="/people/"]')?.textContent).slice(0, 24);
      const excerpt = cleanText(container?.querySelector?.('.RichContent-inner, [class*="RichText"], [class*="ContentItem"]')?.textContent || container?.textContent).slice(0, 48);
      answers.push({ answerId, author, excerpt });
    }

    const fromUrl = extractAnswerIdFromUrl();
    if (fromUrl) addAnswer(fromUrl, document.body);

    document.querySelectorAll([
      'a[href*="/answer/"]',
      '[data-zop]',
      '[data-answer-id]',
      '[data-answerid]',
      '[id^="answer-"]',
      '[data-za-extra-module]',
    ].join(', ')).forEach(el => {
      addAnswer(extractAnswerIdFromText(el.getAttribute('href')), el);
      addAnswer(el.getAttribute('data-answer-id'), el);
      addAnswer(el.getAttribute('data-answerid'), el);
      addAnswer(extractAnswerIdFromText(el.id), el);
      addAnswer(extractAnswerIdFromText(el.getAttribute('data-zop')), el);
      addAnswer(extractAnswerIdFromText(el.getAttribute('data-za-extra-module')), el);
    });

    return answers;
  }

  function findAnswerContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return document.body;
    return el.closest('.AnswerItem, [class*="AnswerItem"], .ContentItem, [class*="ContentItem"]') || el;
  }

  function extractAnswerIdFromText(text) {
    if (!text) return null;
    const value = String(text);
    const match = value.match(/\/answer\/(\d+)/)
      || value.match(/answer[_-]?id["'=:\s]+(\d+)/i)
      || value.match(/itemId["'=:\s]+(\d+)/i)
      || value.match(/answer-(\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * 从页面 DOM 提取当前页面上所有可见评论的信息
   * @returns {Array<{commentId: string, author: string, content: string, element?: Element}>}
   */
  function extractCommentIds() {
    const comments = [];
    const seen = new Set();

    collectCommentElements().forEach(el => {
      const id = extractCommentIdFromElement(el);
      if (!id || seen.has(id)) return;
      seen.add(id);

      const authorEl = el.querySelector([
        '[class*="Author"] a[href*="/people/"]',
        '.CommentItem-meta a[href*="/people/"]',
        'a[href*="/people/"]',
        '[class*="name"]',
      ].join(', '));
      const contentEl = el.querySelector([
        '.CommentContent',
        '[class*="CommentContent"]',
        '[class*="content"]',
        '[class*="Content"]',
        'p',
      ].join(', '));

      comments.push({
        commentId: id,
        author: cleanText(authorEl?.textContent).slice(0, 20),
        content: cleanText(contentEl?.textContent).slice(0, 40),
        element: el,
      });
    });

    return comments;
  }

  function collectCommentElements() {
    const elements = new Set();

    document.querySelectorAll([
      '.CommentItem',
      '[class*="CommentItem"]',
      '[data-comment-id]',
      '[data-commentid]',
      '[data-id]',
      '[id^="comment-"]',
      '[id*="comment"]',
      'a[href*="comment"]',
    ].join(', ')).forEach(el => {
      if (!extractCommentIdFromElement(el)) return;
      const container = findCommentContainer(el);
      if (container) {
        elements.add(container);
      }
    });

    return Array.from(elements);
  }

  function findCommentContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const known = el.closest('.CommentItem, [class*="CommentItem"], [class*="comment-item"], [class*="commentItem"]');
    if (known) return known;

    let current = el;
    let fallback = el;
    for (let i = 0; i < 7 && current; i++) {
      const text = cleanText(current.textContent);
      const hasAuthor = !!current.querySelector?.('a[href*="/people/"]');
      const hasAction = hasCommentActionControls(current);
      if (text.length >= 2 && text.length <= 3000 && hasAction) {
        return current;
      }
      if (text.length >= 2 && text.length <= 2000 && hasAuthor) fallback = current;
      current = current.parentElement;
    }

    return fallback;
  }

  function hasCommentActionControls(el) {
    if (!el?.querySelectorAll) return false;
    return Array.from(el.querySelectorAll('button, [role="button"], a, span')).some(node => {
      const label = cleanText([
        node.textContent,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
      ].join(' '));
      return /回复|喜爱|赞|like/i.test(label);
    });
  }

  function extractCommentIdFromElement(el) {
    const candidates = [
      el.getAttribute('data-comment-id'),
      el.getAttribute('data-commentid'),
      el.getAttribute('data-id'),
      extractCommentIdFromText(el.id),
    ];

    el.querySelectorAll?.('[data-comment-id], [data-commentid], [data-id], [id^="comment-"], a[href*="comment"]').forEach(child => {
      candidates.push(
        child.getAttribute('data-comment-id'),
        child.getAttribute('data-commentid'),
        child.getAttribute('data-id'),
        extractCommentIdFromText(child.id),
        extractCommentIdFromText(child.getAttribute('href') || '')
      );
    });

    return candidates.find(isLikelyCommentId) || null;
  }

  function extractCommentIdFromText(text) {
    if (!text) return null;
    const match = String(text).match(/(?:comment[_/-]?|comment_id=)(\d{4,})/i) || String(text).match(/(?:^|[^\d])(\d{6,})(?:[^\d]|$)/);
    return match ? match[1] : null;
  }

  function isLikelyCommentId(value) {
    return /^\d{4,}$/.test(String(value || ''));
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 从 URL 提取关注者/被关注者的 url_token
   */
  function extractProfileTokenFromUrl() {
    const m = location.pathname.match(/\/people\/([^/]+)/);
    return m ? m[1] : null;
  }

  // ── 用户信息提取 ────────────────────────────

  /**
   * 从 DOM 提取页面上所有可见用户的信息
   * 返回: [{ urlToken, name, element, context: { bio, comment, answer, article } }]
   */
  function extractUsers() {
    const usersMap = new Map(); // urlToken -> user info

    // 1. 从所有用户链接提取 url_token 和用户名
    const userLinks = document.querySelectorAll('a[href*="/people/"]');
    userLinks.forEach(link => {
      const urlToken = extractUrlTokenFromUrl(link.href);
      if (!urlToken || urlToken === 'undefined') return;

      // 找最近的卡片容器
      const card = link.closest('.ContentItem, .List-item, .AnswerItem, .ArticleItem, .CommentItem, .MemberList-item, .UserLink-link') || link.parentElement;

      if (!usersMap.has(urlToken)) {
        usersMap.set(urlToken, {
          urlToken,
          name: link.textContent.trim(),
          element: card,
          context: { bio: '', comment: '', answer: '', article: '' },
        });
      }

      const user = usersMap.get(urlToken);
      // 更新名字（优先用更完整的名字）
      const linkText = link.textContent.trim();
      if (linkText && linkText.length > user.name.length) {
        user.name = linkText;
      }
    });

    // 2. 提取各类内容用于关键词匹配
    usersMap.forEach((user, urlToken) => {
      const card = user.element;
      if (!card) return;

      // 签名/bio — 从用户卡片区域
      const bioEl = card.querySelector(
        '.Bio, .zhihu-signature, .UserHead-badge, .MemberItem-headline, [class*="headline"], [class*="Signature"]'
      );
      if (bioEl) user.context.bio = bioEl.textContent.trim();

      // 回答内容
      const answerEl = card.querySelector('.RichContent-inner, .AnswerItem-content, [class*="RichText"]');
      if (answerEl) user.context.answer = answerEl.textContent.trim().slice(0, 2000);

      // 文章内容
      const articleEl = card.querySelector('.ArticleItem-content, .Post-RichTextContainer, .RichContent-inner');
      if (articleEl && !user.context.answer) {
        user.context.article = articleEl.textContent.trim().slice(0, 2000);
      }

      // 评论内容
      const commentEl = card.querySelector('.CommentContent, .CommentItem-content, [class*="comment"] [class*="content"]');
      if (commentEl) user.context.comment = commentEl.textContent.trim().slice(0, 1000);
    });

    return Array.from(usersMap.values());
  }

  // ── 关键词匹配 ─────────────────────────────

  const SOURCE_FIELD_MAP = {
    bio: 'bio',
    comment: 'comment',
    answer: 'answer',
    article: 'article',
  };

  /**
   * 根据规则匹配用户
   * @param {Array} users  extractUsers() 的返回值
   * @param {Array} rules  [{ keyword, sources }]
   * @returns {Array} 匹配的用户，附带 matchedRules
   */
  function matchUsers(users, rules) {
    if (!rules.length) return [];

    return users.filter(user => {
      const matched = [];
      for (const rule of rules) {
        const kw = rule.keyword.toLowerCase();
        for (const source of rule.sources) {
          const field = user.context[SOURCE_FIELD_MAP[source]] || '';
          if (field.toLowerCase().includes(kw)) {
            matched.push({ rule, source });
            break; // 一个规则只匹配一次
          }
        }
      }
      if (matched.length > 0) {
        user.matchedRules = matched;
        return true;
      }
      return false;
    });
  }

  /**
   * 一键扫描：提取 + 匹配
   */
  async function scan() {
    const users = extractUsers();
    const rules = await ZBStorage.getRules();
    return matchUsers(users, rules);
  }

  return {
    detectPageType,
    extractUrlTokenFromUrl,
    extractAnswerIdFromUrl,
    extractAnswerIdFromPage,
    extractAnswerIdsFromPage,
    extractCommentIds,
    extractProfileTokenFromUrl,
    extractUsers,
    matchUsers,
    scan,
  };
})();
