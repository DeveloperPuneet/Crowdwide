import { env, pipeline, TextStreamer } from '@huggingface/transformers';

const MODEL_ID = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const ONNX_RUNTIME_VERSION = '1.31.0-dev.20260914-8d85527a0';
const WASM_BASE = `/vendor/onnxruntime-web/`;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${WASM_BASE}ort-wasm-simd-threaded.jsep.mjs?v=${ONNX_RUNTIME_VERSION}`,
  wasm: `${WASM_BASE}ort-wasm-simd-threaded.jsep.wasm?v=${ONNX_RUNTIME_VERSION}`
};

let generator = null;
let generatorPreference = null;
let generatorDevice = null;

function send(id, type, details = {}) {
  self.postMessage({ id, type, ...details });
}

function progressCallback(id, info) {
  if (!info) return;
  const file = info.file || info.name || 'model files';
  const progress = Number.isFinite(info.progress) ? info.progress : null;
  const message = info.status === 'progress'
    ? `Downloading ${file}…`
    : info.status === 'done'
      ? `Loaded ${file}.`
      : `Preparing ${file}…`;
  send(id, 'progress', { message, progress });
}

async function loadPipeline(id, device) {
  send(id, 'progress', { message: `Loading the ${device === 'webgpu' ? 'GPU' : 'CPU/WASM'} runtime…` });
  return pipeline('text-generation', MODEL_ID, {
    device,
    dtype: device === 'webgpu' ? 'q4f16' : 'q4',
    progress_callback: (info) => progressCallback(id, info)
  });
}

async function disposePipeline() {
  const previous = generator;
  generator = null;
  generatorDevice = null;
  if (previous?.model?.dispose) await previous.model.dispose();
}

async function ensurePipeline(id, preference) {
  if (generator && generatorPreference === preference) return generator;
  await disposePipeline();
  generatorPreference = preference;

  if (preference !== 'cpu') {
    try {
      if (!navigator.gpu?.requestAdapter) throw new Error('WebGPU is not available.');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
      generator = await loadPipeline(id, 'webgpu');
      generatorDevice = 'webgpu';
      return generator;
    } catch (error) {
      send(id, 'fallback', {
        message: `GPU initialization failed (${error.message || 'unsupported device'}).`
      });
      await disposePipeline();
    }
  }

  generator = await loadPipeline(id, 'wasm');
  generatorDevice = 'wasm';
  return generator;
}

async function runGeneration(id, messages) {
  let tokenCount = 0;
  let streamedText = '';
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    callback_function: (text) => {
      streamedText += text;
      if (text) send(id, 'text', { text });
    },
    token_callback_function: () => {
      tokenCount += 1;
      send(id, 'token', { count: tokenCount, device: generatorDevice });
    }
  });
  const result = await generator(messages, {
    max_new_tokens: 128,
    do_sample: true,
    temperature: 0.4,
    top_p: 0.9,
    repetition_penalty: 1.08,
    streamer
  });
  const generated = result?.[0]?.generated_text;
  const answer = Array.isArray(generated)
    ? generated.at(-1)?.content
    : generated;
  return String(answer || streamedText).trim();
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'generate' || !Number.isSafeInteger(data.id)) return;
  const { id } = data;
  try {
    await ensurePipeline(id, ['auto', 'cpu', 'gpu'].includes(data.device) ? data.device : 'auto');
    send(id, 'device', { device: generatorDevice });
    let answer;
    try {
      answer = await runGeneration(id, data.messages);
    } catch (error) {
      if (generatorDevice !== 'webgpu') throw error;
      send(id, 'retry', { message: 'GPU inference failed. Retrying with CPU/WASM…' });
      await disposePipeline();
      generatorPreference = ['auto', 'cpu', 'gpu'].includes(data.device) ? data.device : 'auto';
      generator = await loadPipeline(id, 'wasm');
      generatorDevice = 'wasm';
      send(id, 'device', { device: generatorDevice });
      answer = await runGeneration(id, data.messages);
    }
    if (!answer) throw new Error('The model returned an empty response.');
    send(id, 'done', { answer, device: generatorDevice });
  } catch (error) {
    send(id, 'error', { message: error.message || 'On-device inference failed.' });
  }
});
