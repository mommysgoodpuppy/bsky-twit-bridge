import sys
import json
import asyncio
from twikit import Client

# Hard ceiling on pagination, so a large count can't walk the whole timeline.
MAX_TWEETS = 400

async def get_user_tweets(username, count=10, cookie_path='cookies.json'):
    client = Client('en-US')

    # Try to load cookies if they exist
    try:
        client.load_cookies(cookie_path)
    except Exception:
        print(json.dumps({"error": f"Not logged in: could not load {cookie_path}"}))
        return
    
    try:
        # Get user by screen name to get user ID
        user = await client.get_user_by_screen_name(username)
        user_id = user.id
        
        # One request returns a single page (~20 tweets), whatever count says, so
        # page through until we have enough for the caller's backfill window.
        tweets = []
        page = await client.get_user_tweets(user_id, 'Tweets', count=count)
        while page:
            tweets.extend(page)
            if len(tweets) >= count or len(tweets) >= MAX_TWEETS:
                break
            page = await page.next()

        tweets_data = []
        for tweet in tweets:
            # Skip retweets
            if tweet.text.startswith('RT @'):
                continue
            
            media = []
            if tweet.media:
                for m in tweet.media:
                    media_url = None
                    media_type = m.type
                    
                    # For photos, use media_url
                    if hasattr(m, 'media_url'):
                        media_url = m.media_url
                    
                    # For videos, try to get the best quality video URL
                    if media_type == 'video' and hasattr(m, 'streams') and m.streams:
                        # Get the highest bitrate stream
                        best_stream = max(m.streams, key=lambda s: s.bitrate if hasattr(s, 'bitrate') and s.bitrate else 0)
                        if hasattr(best_stream, 'url'):
                            media_url = best_stream.url
                    
                    if media_url:
                        # Bluesky crops to a square unless the embed carries an
                        # aspectRatio, so pass the original dimensions along.
                        width = height = None
                        info = m.original_info
                        if isinstance(info, dict):
                            width = info.get('width')
                            height = info.get('height')
                        if not (width and height):
                            aspect_ratio = getattr(m, 'aspect_ratio', None)
                            if aspect_ratio:
                                width, height = aspect_ratio

                        # Duration lets the transcode trim without shipping ffprobe.
                        duration_millis = None
                        if media_type == 'video':
                            video_info = m._data.get('video_info') or {}
                            duration_millis = video_info.get('duration_millis')

                        media.append({
                            'type': media_type,
                            'url': media_url,
                            'width': width,
                            'height': height,
                            'duration_millis': duration_millis
                        })
            
            # Only the quoted tweet's id is needed: the bridge turns it into a
            # Bluesky quote post if it has already mirrored that tweet.
            quoted_id = None
            try:
                quoted = tweet.quote
                if quoted:
                    quoted_id = quoted.id
            except Exception:
                pass

            tweets_data.append({
                'id': tweet.id,
                'text': tweet.text,
                'media': media,
                'created_at': tweet.created_at,
                'quoted_id': quoted_id
            })
        
        print(json.dumps(tweets_data))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == '__main__':
    username = sys.argv[1] if len(sys.argv) > 1 else None
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    cookie_path = sys.argv[3] if len(sys.argv) > 3 else 'cookies.json'

    if not username:
        print(json.dumps({"error": "Username required"}))
        sys.exit(1)

    asyncio.run(get_user_tweets(username, count, cookie_path))
