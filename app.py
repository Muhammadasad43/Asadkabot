import os
import json
import requests
from flask import Flask, render_template, request, Response

app = Flask(__name__)

# 🔑 ENVIRONMENT VARIABLES (With .strip() safety for both keys)
POLLINATIONS_API_KEY = os.environ.get("POLLINATIONS_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

AVAILABLE_MODELS = {
    "qwen-coder": "Qwen 2.5 Coder 32B (Tech/Raw)",
    "deepseek": "DeepSeek V3.2 (Reasoning)",
    "openai": "GPT-4o (Standard Base)",
    "gpt-5.4-mini": "GPT-5.4 Nano Engine",
    "kimi": "Kimi K2.5 (Default Text)",
    "kimi-code": "Kimi K2.6 (Strong Agentic)",
    "llama": "Llama 3.3 70B (Open-Weights)",
    "llama-groq": "Llama 70B 2nd (Groq Engine)",  # ⚡ Added 2nd engine option
    "mistral": "Mistral Small 4",
    "glm": "Z.ai GLM 5"
}

@app.route('/')
def index():
    return render_template('index.html', models=AVAILABLE_MODELS)

@app.route('/chat_stream', methods=['POST'])
def chat_stream():
    data = request.json or {}
    history_messages = data.get('messages', [])
    selected_model = data.get('model', 'qwen-coder')

    if not history_messages:
        return {"error": "No messages array provided"}, 400

    # 🌐 ROUTE A: IF USER SELECTS THE NEW GROQ ENGINE
    if selected_model == "llama-groq":
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
                    "messages": history_messages, # Full history support
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

    # 🌐 ROUTE B: DEFAULT POLLINATIONS ENGINES
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

def get_stream_headers():
    return {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
    }

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
