// model_runtime_v3.js
// model_runtime_v3.js
export const KhatersModel = (() => {
    let meta = null;
    let vocab = null;
    let W_off = null, b_off = 0;
    let W_target = null, b_target = null;
    let W_fine = null, b_fine = null;
    let W_label = null, b_label = null;

    // -------- util: fetch binary float32 --------
    async function fetchF32(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
        const buf = await res.arrayBuffer();
        return new Float32Array(buf);
    }

    async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
        return await res.json();
    }

    // -------- util: math --------
    function sigmoid(x) {
        // clamp for stability
        if (x > 35) return 1;
        if (x < -35) return 0;
        return 1 / (1 + Math.exp(-x));
    }

    function softmax(arr) {
        let max = -Infinity;
        for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
        let sum = 0;
        const exps = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            const e = Math.exp(arr[i] - max);
            exps[i] = e;
            sum += e;
        }
        for (let i = 0; i < arr.length; i++) exps[i] /= sum;
        return exps;
    }

    function normalizeText(s) {
        // sklearn lowercase=True
        // We also handle Korean here naturally as characters
        return (s ?? "").toLowerCase();
    }

    // Vocabulary-based vectorization (CountVectorizer equivalent)
    function vectorizeWithVocab(text) {
        if (!vocab) throw new Error("Vocabulary not loaded");

        const dim = meta.dim;
        // Default to char ngram 3-5 if not in meta
        const nmin = meta.vectorizer?.ngram_min ?? 3;
        const nmax = meta.vectorizer?.ngram_max ?? 5;

        const s = normalizeText(text);

        // sparse counts as Map
        const counts = new Map();
        const L = s.length;

        for (let n = nmin; n <= nmax; n++) {
            if (L < n) continue;
            for (let i = 0; i <= L - n; i++) {
                const ngram = s.slice(i, i + n);
                // Look up in vocab
                const idx = vocab[ngram];
                if (idx !== undefined) {
                    counts.set(idx, (counts.get(idx) || 0) + 1);
                }
            }
        }

        // L2 normalize (norm="l2" is implicit in our previous hashing logic, checking if we kept it)
        // Wait, CountVectorizer usually defaults to norm=None, but TfidfVectorizer defaults to l2.
        // In train_export_v3.py we used CountVectorizer. 
        // *However*, we didn't specify 'norm' param because CountVectorizer doesn't have it!
        // SGDClassifier expects normalized input for best performance usually, but CountVectorizer outputs raw counts.
        // Let's check train_export_v3.py again. 
        // "return CountVectorizer(max_features=DIM, ...)"
        // It produces raw counts (integers).
        // 
        // PREVIOUSLY: HashingVectorizer had norm="l2".
        // NOW: CountVectorizer has NO norm (it's raw counts).
        //
        // CRITICAL: SGDClassifier with standard scaler or just raw counts? 
        // If we trained on RAW counts, we must infer on RAW counts.
        // If we want L2 normalization, we should have used TfidfVectorizer(use_idf=False, norm='l2') or a Normalizer.
        // 
        // Let's assume raw counts for now as per my code change.
        // If the model performs poorly, I might need to add normalization. 
        // But for now, I will match what the training script does: RAW COUNTS.

        // Actually, let's normalize to be safe? No, consistency is key.
        // Training script: Xv = vec.fit_transform(X). This is raw counts.
        // So inference must be raw counts.

        // ... But wait, raw counts range can be large. SGDClassifier handles it ok? 
        // Usually yes, but convergence might differ.
        // Let's stick to raw counts.

        // return sparse arrays
        const idxs = new Uint32Array(counts.size);
        const vals = new Float32Array(counts.size);
        let k = 0;
        for (const [i, v] of counts.entries()) {
            idxs[k] = i;
            vals[k] = v; // RAW COUNT
            k++;
        }
        return { idxs, vals };
    }

    // dot(W_row, x_sparse) + b
    function dotRow(W, row, x) {
        const dim = meta.dim;
        const base = row * dim;
        let sum = 0;
        const { idxs, vals } = x;
        for (let k = 0; k < idxs.length; k++) {
            sum += W[base + idxs[k]] * vals[k];
        }
        return sum;
    }

    function argmax(arr) {
        let bestI = 0;
        let bestV = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] > bestV) {
                bestV = arr[i];
                bestI = i;
            }
        }
        return bestI;
    }

    // -------- public API --------
    async function load(modelDir = "./model") {
        meta = await fetchJson(`${modelDir}/meta.json`);

        try {
            vocab = await fetchJson(`${modelDir}/vocab.json`);
        } catch (e) {
            console.warn("Failed to load vocab.json, falling back or erroring", e);
            throw new Error("vocab.json required for this version of the model");
        }

        W_off = await fetchF32(`${modelDir}/W_off.f32.bin`);
        const bOffArr = await fetchF32(`${modelDir}/b_off.f32.bin`);
        b_off = bOffArr[0];

        W_target = await fetchF32(`${modelDir}/W_target.f32.bin`);
        b_target = await fetchF32(`${modelDir}/b_target.f32.bin`);

        W_fine = await fetchF32(`${modelDir}/W_fine.f32.bin`);
        b_fine = await fetchF32(`${modelDir}/b_fine.f32.bin`);

        W_label = await fetchF32(`${modelDir}/W_label.f32.bin`);
        b_label = await fetchF32(`${modelDir}/b_label.f32.bin`);
    }

    function predict(text, opts = {}) {
        if (!meta || !vocab) throw new Error("model not loaded");

        const {
            // 논문식 합성 임계값(기본값)
            offensiveThreshold = 0.5,
            targetGate = 0.45,
            l2ThreatGate = 0.45,
            // 디버그 정보 반환
            debug = true
        } = opts;

        const x = vectorizeWithVocab(text);

        // (1) offensive prob
        let sOff = b_off;
        // W_off는 (D,) 이라 dot을 직접
        for (let k = 0; k < x.idxs.length; k++) {
            sOff += W_off[x.idxs[k]] * x.vals[k];
        }
        const pOff = sigmoid(sOff);

        // (2) targets prob (9)
        const pTargets = meta.targets.map((_, i) => sigmoid(dotRow(W_target, i, x) + b_target[i]));
        const maxTarget = Math.max(...pTargets);
        const topTargetIdx = pTargets.indexOf(maxTarget);

        // (3) fine prob (4)
        const pFine = meta.fine.map((_, i) => sigmoid(dotRow(W_fine, i, x) + b_fine[i]));
        const threatIdx = meta.fine.indexOf("threat");
        const pThreat = threatIdx >= 0 ? pFine[threatIdx] : 0;

        // (4) optional 4-class label distribution (참고용)
        const logits = meta.labels.map((_, i) => dotRow(W_label, i, x) + b_label[i]);
        const pLabel = softmax(logits);
        const label4 = meta.labels[argmax(pLabel)];

        // (5) 논문식 합성(권장 기본 규칙)
        let final;
        if (pOff < offensiveThreshold) {
            final = "normal";
        } else {
            if (maxTarget < targetGate) {
                final = "offensive";
            } else {
                // target이 뚜렷하면 hate로
                if (pThreat >= l2ThreatGate) final = "L2_hate";
                else final = "L1_hate";
            }
        }

        // Detailed debug logging
        if (debug) {
            // Only log if something interesting happens or if requested
            // console.log("Text:", text, "Tokens:", x.idxs.length);
        }

        return {
            label: final,
            label4,          // 4-class 직접 분류(참고)
            pOff,
            targets: meta.targets,
            pTargets,
            fine: meta.fine,
            pFine,
            debug: debug ? { maxTarget, topTarget: meta.targets[topTargetIdx], pThreat, pLabel, tokens: x.idxs.length } : undefined
        };
    }

    return { load, predict };
})();
