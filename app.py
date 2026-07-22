import os
import json
import urllib.parse
import requests
from flask import Flask, render_template, request, Response

app = Flask(__name__)

# 🔑 DYNAMIC MULTI-TOKEN LOADER (Render Environment Variables)
# System automatically POLLINATIONS_API_KEY, POLLINATION2, POLLINATION3... sab utha lega
POLLINATIONS_API_KEYS = []

# Primary Key
primary_key = os.environ.get("POLLINATIONS_API_KEY", "").strip()
if primary_key:
    POLLINATIONS_API_KEYS.append(primary_key)

# Sequential Keys like POLLINATION2, POLLINATION3, POLLINATION4 etc.
for env_name, env_val in os.environ.items():
    if env_name.startswith("POLLINATION") and env_name != "POLLINATIONS_API_KEY":
        val = env_val.strip()
        if val and val not in POLLINATIONS_API_KEYS:
            POLLINATIONS_API_KEYS.append(val)

# Fallback/Dummy key list check
print(f"✅ Active Pollinations Keys Loaded: {len(POLLINATIONS_API_KEYS)}")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

AVAILABLE_MODELS = {
    "image-gen": "🎨 Fast Image Generator (FLUX AI)",
    "llama-groq": "Llama 70B Meta AI (Lightning Fast)",
    "gpt-5.4-mini": "GPT-5.4",
    "deepseek": "DeepSeek V3.2 (Reasoning)",
    "openai": "GPT-4o (Standard)",
    "llama": "Llama 3.3 70B (Meta AI)",
    "mistral": "Mistral 4 Uncensored"
}

@app.route('/')
def index():
    return render_template('index.html', models=AVAILABLE_MODELS)

def get_stream_headers():
    return {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
    }

# Function to get a working token from the pool
def get_valid_token():
    return POLLINATIONS_API_KEYS[0] if POLLINATIONS_API_KEYS else ""

@app.route('/chat_stream', methods=['POST'])
def chat_stream():
    data = request.json or {}
    history_messages = data.get('messages', [])
    selected_model = data.get('model', 'llama-groq')

    if not history_messages:
        return {"error": "No messages provided"}, 400

    last_user_message = history_messages[-1]['content'] if history_messages else ""

    # ==========================================
    # 🖼️ ROUTE 1: FAST INSTANT IMAGE GENERATION
    # ==========================================
    if selected_model == "image-gen":
        def generate_image():
            yield "data: [STATUS: Generating image link...] 🎨\n\n"
            try:
                encoded_prompt = urllib.parse.quote(last_user_message)
                active_key = get_valid_token()
                
                # Image Direct CDN URL (Fast Load)
                image_url = f"https://gen.pollinations.ai/image/{encoded_prompt}?model=flux&width=1024&height=1024"
                if active_key:
                    image_url += f"&key={active_key}"

                # Browser immediate render element + Direct Download button
                img_html = f'''
<div class="generated-img-container" style="margin-top:10px;">
    <img src="{image_url}" alt="Generated Image" loading="eager" style="max-width:100%; border-radius:12px; border:1px solid #1e2335; box-shadow:0 8px 20px rgba(0,0,0,0.4);" />
    <br>
    <a href="{image_url}" target="_blank" download="pollinations-artwork.jpg" style="display:inline-block; margin-top:10px; background:#10b981; color:#fff; padding:8px 16px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:0.85rem; box-shadow:0 4px 12px rgba(16,185,129,0.3);">
        📥 Open / Download Image
    </a>
</div>
'''
                yield f"data: {json.dumps({'token': img_html})}\n\n"

            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return Response(generate_image(), mimetype='text/event-stream', headers=get_stream_headers())

    # ==========================================
    # 🧠 ROUTE 2: TEXT STREAMING (GROQ / LLAMA)
    # ==========================================
    elif selected_model == "llama-groq":
        def generate_groq():
            yield "data: [STATUS: Brainstorming via Groq...] 🧠\n\n"
            try:
                url = "https://api.groq.com/openai/v1/chat/completions"
                headers = {
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json"
                }
                payload = {
                    "model": "llama-3.3-70b-versatile",
                    "messages": history_messages,
                    "stream": True
                }
                response = requests.post(url, json=payload, headers=headers, stream=True)
                
                for line in response.iter_lines():
                    if line:
                        line_str = line.decode('utf-8').strip()
                        if line_str.startswith("data: "):
                            if line_str == "data: [DONE]": 
                                break
                            try:
                                data_json = json.loads(line_str[6:])
                                token = data_json['choices'][0]['delta'].get('content', '')
                                if token:
                                    yield f"data: {json.dumps({'token': token})}\n\n"
                            except:
                                pass
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return Response(generate_groq(), mimetype='text/event-stream', headers=get_stream_headers())

    # ==========================================
    # 💬 ROUTE 3: OTHER POLLINATIONS TEXT MODELS
    # ==========================================
    else:
        def generate_pollinations():
            yield f"data: [STATUS: Core Engine -> {selected_model}] 🧠\n\n"
            try:
                url = "https://gen.pollinations.ai/v1/chat/completions"
                
                active_key = get_valid_token()
                headers = {"Content-Type": "application/json"}
                if active_key:
                    headers["Authorization"] = f"Bearer {active_key}"

                payload = {
                    "model": selected_model,
                    "messages": history_messages,
                    "stream": True
                }
                response = requests.post(url, json=payload, headers=headers, stream=True)

                for line in response.iter_lines():
                    if line:
                        line_str = line.decode('utf-8').strip()
                        if line_str.startswith("data: "):
                            if line_str == "data: [DONE]": 
                                break
                            try:
                                data_json = json.loads(line_str[6:])
                                token = data_json['choices'][0]['delta'].get('content', '')
                                if token: 
                                    yield f"data: {json.dumps({'token': token})}\n\n"
                            except:
                                pass
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return Response(generate_pollinations(), mimetype='text/event-stream', headers=get_stream_headers())

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
        
