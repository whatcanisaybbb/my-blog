/**
 * GitHub API 存储层
 * 用 GitHub API 直接读写仓库里的 posts.json 文件
 */
const GitHubStore = (() => {
  // ===== 配置 =====
  // ⚠️ 重要：部署到 GitHub Pages 后，token 会暴露在客户端代码里
  // 这是为了方便你一个人使用。如果多人使用，需要加一个后端代理。
  const CONFIG = {
    owner: 'whatcanisaybbb',
    repo: 'my-blog',
    branch: 'main',
    dataFile: 'data/posts.json'
  };

  let token = localStorage.getItem('gh_token') || '';

  function headers(requireAuth) {
    const h = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    if (requireAuth && token) {
      h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  // 获取文件内容（返回 { content: [...], sha: '...' }）
  async function fetchPosts() {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataFile}?ref=${CONFIG.branch}`;
    const res = await fetch(url, { headers: headers(false) });
    if (res.status === 404) {
      return { content: [], sha: null };
    }
    if (!res.ok) throw new Error('获取文章失败: ' + res.status);
    const data = await res.json();
    const decoded = JSON.parse(atob(data.content));
    return { content: decoded, sha: data.sha };
  }

  // 保存文件（创建或更新）
  async function savePosts(posts, sha) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataFile}`;
    const body = JSON.stringify({
      message: '更新博客文章',
      content: btoa(unescape(encodeURIComponent(JSON.stringify(posts, null, 2)))),
      branch: CONFIG.branch,
      sha: sha  // 更新时需要传 sha
    });
    const res = await fetch(url, { method: 'PUT', headers: headers(true), body });
    if (!res.ok) {
      const err = await res.json();
      throw new Error('保存失败: ' + (err.message || res.status));
    }
    return await res.json();
  }

  // ===== 公开 API =====

  // 获取所有文章
  async function getPosts() {
    const { content } = await fetchPosts();
    content.sort((a, b) => new Date(b.date) - new Date(a.date));
    return content;
  }

  // 获取单篇文章
  async function getPost(id) {
    const { content } = await fetchPosts();
    return content.find(p => p.id === id) || null;
  }

  // 创建文章
  async function createPost(post) {
    const { content, sha } = await fetchPosts();
    const newPost = {
      ...post,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      updated: new Date().toISOString()
    };
    content.push(newPost);
    await savePosts(content, sha);
    return newPost;
  }

  // 更新文章
  async function updatePost(id, updates) {
    const { content, sha } = await fetchPosts();
    const idx = content.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('文章不存在');
    content[idx] = { ...content[idx], ...updates, updated: new Date().toISOString() };
    await savePosts(content, sha);
    return content[idx];
  }

  // 删除文章
  async function deletePost(id) {
    const { content, sha } = await fetchPosts();
    const filtered = content.filter(p => p.id !== id);
    if (filtered.length === content.length) throw new Error('文章不存在');
    await savePosts(filtered, sha);
    return true;
  }

  // 验证 token 是否有效
  async function verifyToken(tokenToVerify) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${tokenToVerify}`,
        'Accept': 'application/vnd.github+json'
      }
    });
    return res.ok;
  }

  function setToken(t) {
    token = t;
    localStorage.setItem('gh_token', t);
  }

  function getToken() {
    return token;
  }

  function clearToken() {
    token = '';
    localStorage.removeItem('gh_token');
  }

  return {
    getPosts, getPost, createPost, updatePost, deletePost,
    verifyToken, setToken, getToken, clearToken
  };
})();
