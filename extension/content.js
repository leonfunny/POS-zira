// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_posts") {
    const posts = getPosts(request.limit || 5);
    sendResponse({ success: true, data: posts });
  } 
  else if (request.action === "like_post") {
    const result = interactWithPost(request.index, 'like');
    sendResponse(result);
  }
  else if (request.action === "comment_post") {
    const result = commentOnPost(request.index, request.text);
    sendResponse(result);
  }
  else if (request.action === "scroll") {
    window.scrollBy(0, request.amount || 500);
    sendResponse({ success: true });
  }
  return true; // Keep channel open for async response
});

function getPosts(limit) {
  const articles = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper, .x1yztbdb');
  const results = [];
  
  for (let i = 0; i < Math.min(limit, articles.length); i++) {
    const el = articles[i];
    const text = el.innerText || el.textContent || '';
    
    // Attempt to find author
    const authorEl = el.querySelector('strong, h3, h4, span[style*="font-weight: 600"]');
    const author = authorEl ? authorEl.innerText : 'Unknown';
    
    // Check for media
    const hasImage = !!el.querySelector('img:not([role="presentation"])');
    const hasVideo = !!el.querySelector('video');

    if (text.length > 10) {
      results.push({
        index: i,
        author,
        content: text.substring(0, 300).replace(/\n/g, ' '),
        hasImage,
        hasVideo
      });
    }
  }
  return results;
}

function interactWithPost(index, action) {
  const articles = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper, .x1yztbdb');
  const post = articles[index];
  
  if (!post) return { success: false, error: "Post not found" };
  
  post.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  if (action === 'like') {
    const likeBtn = post.querySelector('[aria-label="Like"], [aria-label="Thích"], [data-testid="UFI2ReactionLink"]');
    if (likeBtn) {
      likeBtn.click();
      return { success: true, message: "Liked post " + index };
    }
    return { success: false, error: "Like button not found" };
  }
  return { success: false, error: "Unknown action" };
}

function commentOnPost(index, text) {
    // Basic implementation - finding comment box is tricky and changes often
    // For now, just scroll to it
    const articles = document.querySelectorAll('[role="article"]');
    const post = articles[index];
    if (!post) return { success: false, error: "Post not found" };
    
    post.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true, message: "Scrolled to post. Auto-typing not fully supported in this version." };
}
