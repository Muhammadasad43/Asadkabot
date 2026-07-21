import os
import json
import requests
from flask import Flask, render_template, request, Response

app = Flask(__name__)

# 🔒 ENVIRONMENT VARIABLES
POLLINATIONS_API_KEY = os.environ.get("POLLINATIONS_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

AVAILABLE_MODELS = {
    "image-gen": "🎨 Image Generator (FLUX AI)",
    "llama-groq": "Llama 70B Meta AI (Lightning Fast)",
    "gpt-5.4-mini": "GPT-5.4",
    "deepseek": "DeepSeek V3.2 (Reasoning)",
    "openai": "GPT-4o (Standard)",
    "llama": "Llama 3.3 70B (Meta AI)",
    "mistral": "Mistral 4 Uncensored",
    "glm": "Z.ai GLM 5",
    "qwen-coder": "Qwen 2.5 Coding Agent (Tech Use)",
    "kimi": "Kimi K2.5 (Default)",
    "kimi-code": "Kimi K2.6 (Strong Agentic)"
}

# 🏠 ROOT ROUTE
@app.route('/')
def index():
    return render_template('index.html', models=AVAILABLE_MODELS)

def get_stream_headers():
    return {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
    }

@app.route('/chat_stream', methods=['POST'])
def chat_stream():
    data = request.json or {}
    history_messages = data.get('messages', [])
    selected_model = data.get('model', 'llama-groq')

    if not history_messages:
        return {"error": "No messages provided"}, 400

    last_user_message = history_messages[-1]['content'] if history_messages else ""

    # 🎨 ROUTE A: IMAGE GENERATOR
    if selected_model == "image-gen":
        def generate_image():
            yield "data: [STATUS: Generating artwork via Pollinations AI...] 🎨\n\n"
            try:
                url = "https://gen.pollinations.ai/v1/images/generations"
                headers = {
                    "Authorization": f"Bearer {POLLINATIONS_API_KEY}",
                    "Content-Type": "application/json"
                }
                payload = {
                    "prompt": last_user_message,
                    "model": "flux",
                    "n": 1,
                    "size": "1024x1024",
                    "quality": "medium",
                    "response_format": "url"
                }

                response = requests.post(url, json=payload, headers=headers, timeout=30)
                
                if response.status_code == 200:
                    res_json = response.json()
                    img_url = res_json['data'][0]['url'] if res_json.get('data') else None
                    
                    if img_url:
                        # 📥 direct download ke liye onclick event lagaya gaya hai
                        img_html = f'''
<div class="generated-img-container" style="margin-top:10px;">
    <img src="{img_url}" alt="Generated Image" style="max-width:100%; border-radius:12px; border:1px solid #1e2335; box-shadow:0 8px 20px rgba(0,0,0,0.4);" />
    <br>
    <button onclick="downloadImageViaJS('{img_url}', 'asad-ai-generated.png')" style="display:inline-block; margin-top:10px; background:#10b981; color:#fff; padding:8px 16px; border-radius:8px; border:none; cursor:pointer; font-weight:bold; font-size:0.85rem; box-shadow:0 4px 12px rgba(16,185,129,0.3);">
        📥 Download Image
    </button>
</div>
'''
                        yield f"data: {json.dumps({'token': img_html})}\n\n"
                    else:
                        yield f"data: {json.dumps({'error': 'Image URL not found in API response.'})}\n\n"
                else:
                    yield f"data: {json.dumps({'error': f'API Error {response.status_code}'})}\n\n"

            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return Response(generate_image(), mimetype='text/event-stream', headers=get_stream_headers())

    # ⚡ ROUTE B: GROQ CHAT
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

    # 🧠 ROUTE C: POLLINATIONS CHAT MODELS
    else:
        def generate_pollinations():
            yield f"data: [STATUS: Core Engine Linked -> {selected_model}] 🧠\n\n"
            try:
                url = "https://gen.pollinations.ai/v1/chat/completions"
                headers = {
                    "Authorization": f"Bearer {POLLINATIONS_API_KEY}",
                    "Content-Type": "application/json"
                }
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
