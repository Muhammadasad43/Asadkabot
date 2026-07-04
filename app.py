import os
import json
import requests
from flask import Flask, render_template, request, Response

app = Flask(__name__)

POLLINATIONS_API_KEY = os.environ.get("POLLINATIONS_API_KEY", "fallback_key_if_needed")

AVAILABLE_MODELS = {
    "qwen-coder": "Qwen 2.5 Coder 32B (Tech/Raw)",
    "deepseek": "DeepSeek V3.2 (Reasoning)",
    "openai": "GPT-4o (Standard Base)",
    "gpt-5.4-mini": "GPT-5.4 Nano Engine",
    "gemini": "Gemini Pro 3 (Context Core)",
    "gemini-search": "Gemini Search (Web-Live)",
    "claude-fast": "Claude 3.5 Haiku",
    "claude": "Claude 3.5 Opus",
    "kimi": "Kimi K2.5 (Default Text)",
    "kimi-code": "Kimi K2.6 (Strong Agentic)",
    "llama": "Llama 3.3 70B (Open-Weights)",
    "mistral": "Mistral Small 4",
    "glm": "Z.ai GLM 5"
}

# 🌐 Render home route jo templates folder se index.html ko load karega
@app.route('/')
def index():
    return render_template('index.html', models=AVAILABLE_MODELS)

@app.route('/chat_stream', methods=['POST'])
def chat_stream():
    data = request.json or {}
    
    # 🧠 CLIENT-SIDE MEMORY: Frontend se poora messages array (history) le rahe hain
    history_messages = data.get('messages', [])
    selected_model = data.get('model', 'qwen-coder')

    if not history_messages:
        return {"error": "No messages array provided"}, 400

    def generate():
        yield f"data: [STATUS: Core Engine Linked -> {selected_model}] 🧠\n\n"
        try:
            url = "https://gen.pollinations.ai/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {POLLINATIONS_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": selected_model,
                "messages": history_messages, # Full history sending to API
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

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )

if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
    
