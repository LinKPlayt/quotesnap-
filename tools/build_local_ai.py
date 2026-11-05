#!/usr/bin/env python3
"""Build the on-device AI files in models/tinyclip-vit-8m-16/.

What it does (run once by a developer; the app itself needs none of this):
  1. Downloads TinyCLIP-ViT-8M/16 (Microsoft, MIT license) at a pinned revision.
  2. Exports only the *image* encoder to ONNX and quantizes its weights to 8 bits
     (MatMulNBits, weight-only), which runs on both WebGPU and WebAssembly.
  3. Turns every text prompt in tools/local-ai-questions.json into a text embedding with
     the model's *text* encoder and stores them in labels.json. The browser never runs the
     text encoder: it compares each photo's image embedding against these vectors.
  4. Checks the quantized model against the original.

Usage:
  python3 -m venv .venv && . .venv/bin/activate
  pip install torch --index-url https://download.pytorch.org/whl/cpu
  pip install transformers onnx onnxruntime onnxscript numpy pillow
  python tools/build_local_ai.py            # model + labels
  python tools/build_local_ai.py --labels   # only re-embed prompts after editing the questions
"""
import argparse, base64, hashlib, json, os, sys, tempfile

import numpy as np
import torch

MODEL_ID = 'wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M'
REVISION = 'a2a8c6eaa2549ad66eb7c31b85022bf58273a26c'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'models', 'tinyclip-vit-8m-16')
QUESTIONS = os.path.join(ROOT, 'tools', 'local-ai-questions.json')


def load():
    from transformers import CLIPModel, CLIPProcessor
    model = CLIPModel.from_pretrained(MODEL_ID, revision=REVISION).eval()
    proc = CLIPProcessor.from_pretrained(MODEL_ID, revision=REVISION)
    return model, proc


def export_vision(model, proc):
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    class Vision(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.vision, self.proj = m.vision_model, m.visual_projection

        def forward(self, pixel_values):
            e = self.proj(self.vision(pixel_values=pixel_values).pooler_output)
            return e / e.norm(dim=-1, keepdim=True)  # unit length: cosine similarity is a dot product

    net = Vision(model).eval()
    with tempfile.TemporaryDirectory() as tmp:
        fp32 = os.path.join(tmp, 'vision_fp32.onnx')
        torch.onnx.export(net, (torch.randn(1, 3, 224, 224),), fp32, input_names=['pixel_values'], output_names=['image_embeds'],
                          dynamic_axes={'pixel_values': {0: 'batch'}, 'image_embeds': {0: 'batch'}}, opset_version=17, dynamo=False)
        q = MatMulNBitsQuantizer(onnx.load(fp32), bits=8, block_size=32, is_symmetric=True)
        q.process()
        dst = os.path.join(OUT, 'vision_q8.onnx')
        q.model.save_model_to_file(dst, use_external_data_format=False)
        # verify against PyTorch
        x = torch.randn(4, 3, 224, 224)
        with torch.no_grad():
            ref = net(x).numpy()
        got = ort.InferenceSession(dst, providers=['CPUExecutionProvider']).run(None, {'pixel_values': x.numpy()})[0]
        cos = (ref * got).sum(1)
        print(f'vision_q8.onnx: {os.path.getsize(dst) / 1e6:.1f} MB, cosine vs fp32 min {cos.min():.4f}')
        if cos.min() < 0.99:
            sys.exit('quantized model drifted too far from the original')



def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def write_config(model, proc):
    ip = proc.image_processor
    config = {
        'id': 'tinyclip-vit-8m-16',
        'name': 'TinyCLIP ViT-8M/16 (image encoder, 8-bit weights)',
        'source': f'https://huggingface.co/{MODEL_ID}',
        'revision': REVISION,
        'license': 'MIT (Copyright (c) Microsoft Corporation)',
        'file': 'vision_q8.onnx',
        'bytes': os.path.getsize(os.path.join(OUT, 'vision_q8.onnx')),
        'input': 'pixel_values',
        'output': 'image_embeds',
        'size': ip.crop_size['height'],
        'mean': list(ip.image_mean),
        'std': list(ip.image_std),
        'sha256': sha256(os.path.join(OUT, 'vision_q8.onnx')),
        'labels': 'labels.json',
        'labelsSha256': sha256(os.path.join(OUT, 'labels.json')),
        'embedDim': model.config.projection_dim,
    }
    json.dump(config, open(os.path.join(OUT, 'config.json'), 'w'), indent=2)
    print('config.json written')


def build_labels(model, proc):
    spec = json.load(open(QUESTIONS))
    templates = spec.get('templates', {})
    vectors, out = [], []
    for q in spec['questions']:
        classes = []
        for cid, prompts in q['classes'].items():
            if 'template' in q:
                prompts = [t.format(prompts) for t in templates[q['template']]]
            tok = proc(text=prompts, return_tensors='pt', padding=True)
            with torch.no_grad():
                te = model.get_text_features(**tok)
            te = getattr(te, 'pooler_output', te)
            te = torch.nn.functional.normalize(te, dim=-1).mean(0)
            vectors.append(torch.nn.functional.normalize(te, dim=-1).numpy().astype(np.float32))
            classes.append({'id': cid, 'prompts': prompts})
        out.append({'id': q['id'], 'classes': classes})
    mat = np.stack(vectors)
    labels = {
        'model': 'tinyclip-vit-8m-16',
        'dim': int(mat.shape[1]),
        'count': int(mat.shape[0]),
        'logitScale': float(model.logit_scale.exp().item()),
        'questions': out,
        'embeddings': base64.b64encode(mat.tobytes()).decode(),  # float32, row per class, question order
    }
    json.dump(labels, open(os.path.join(OUT, 'labels.json'), 'w'), separators=(',', ':'))
    print(f'labels.json: {mat.shape[0]} classes x {mat.shape[1]} dims, logit scale {labels["logitScale"]:.1f}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--labels', action='store_true', help='only rebuild labels.json')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    model, proc = load()
    if not args.labels:
        export_vision(model, proc)
    build_labels(model, proc)
    write_config(model, proc)
