import os
import json
import numpy as np
from datasets import load_dataset
from sklearn.linear_model import SGDClassifier
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.preprocessing import MultiLabelBinarizer

# =========================
# 설정
# =========================
DIM = 2**16  # 65536

LABELS_CANON = ["normal", "offensive", "L1_hate", "L2_hate"]
TARGETS_CANON = ["gender", "age", "race", "religion", "politics",
                 "job", "disability", "individual", "others"]

# 논문 Table 3의 offensiveness rationale 축에 맞춰 최소 축 정의
# (데이터에 없는 축은 자동으로 0만 나오게 처리됨)
FINE_CANON = ["insult", "swear", "obscenity", "threat"]

TARGET_ALIASES = {
    "individuals": "individual",
    "person": "individual",
    "people": "individual",
    "occupation": "job",
    "work": "job",
    "region": "others",
    "nationality": "race",
}

# =========================
# 유틸: 정규화/파싱
# =========================
def normalize_target(t: str) -> str:
    if not t:
        return "others"
    t = str(t).strip().lower()
    t = TARGET_ALIASES.get(t, t)
    if t in TARGETS_CANON:
        return t
    return "others"

def make_vectorizer():
    # Use CountVectorizer with fixed max_features to ensure consistent vocabulary
    # This allows us to export the vocabulary for JS usage
    return CountVectorizer(
        max_features=DIM,
        analyzer="char",
        ngram_range=(3, 5),
        lowercase=True,
    )

def export_bin(arr: np.ndarray, path: str):
    arr.astype(np.float32).tofile(path)

def ensure_2class_binary_or_skip(y_bin, default_if_all0=-20.0, default_if_all1=+20.0):
    """
    binary(0/1)에서 한 클래스만 존재하면 sklearn이 학습을 못 하니까
    bias만으로 상수 예측하게 만들기 위한 도우미.
    """
    uniq = np.unique(y_bin)
    if uniq.size < 2:
        if int(uniq[0]) == 0:
            return None, float(default_if_all0)
        else:
            return None, float(default_if_all1)
    return "fit", None

def extract_fine_tags(off_rationale):
    """
    offensiveness_rationale 컬럼이 어떤 형태인지 확실치 않으니
    최대한 robust하게 'insult/swear/obscenity/threat' 태그를 추출한다.

    가능한 형태들(추정):
    - dict: {"insult": 2, "swear": 0, ...} 또는 {"insult": True, ...}
    - list: [{"type":"insult", ...}, ...] 또는 ["insult", "swear"]
    - str: "insult, swear" 같은 문자열
    - None
    """
    tags = set()
    if off_rationale is None:
        return tags

    # dict 형태
    if isinstance(off_rationale, dict):
        for k, v in off_rationale.items():
            kk = str(k).strip().lower()
            if kk in FINE_CANON:
                try:
                    vv = float(v)
                    if vv > 0:
                        tags.add(kk)
                except:
                    # bool/문자 등
                    if bool(v):
                        tags.add(kk)
        return tags

    # list/tuple 형태
    if isinstance(off_rationale, (list, tuple)):
        for it in off_rationale:
            if it is None:
                continue
            if isinstance(it, dict):
                # 흔한 키 후보들: type, label, category
                for keycand in ("type", "label", "category", "tag"):
                    if keycand in it:
                        kk = str(it[keycand]).strip().lower()
                        if kk in FINE_CANON:
                            tags.add(kk)
            else:
                kk = str(it).strip().lower()
                if kk in FINE_CANON:
                    tags.add(kk)
        return tags

    # string 형태
    if isinstance(off_rationale, str):
        s = off_rationale.lower()
        for kk in FINE_CANON:
            if kk in s:
                tags.add(kk)
        return tags

    # 기타 타입은 문자열로 캐스팅
    s = str(off_rationale).lower()
    for kk in FINE_CANON:
        if kk in s:
            tags.add(kk)
    return tags

# =========================
# 메인
# =========================
def main():
    os.makedirs("model", exist_ok=True)

    print("Loading dataset: humane-lab/K-HATERS ...")
    ds = load_dataset("humane-lab/K-HATERS")
    tr = ds["train"]

    # 컬럼 확인(안전)
    cols = tr.column_names
    print("Columns:", cols)

    X = tr["text"]
    y_label = [str(v).strip() for v in tr["label"]]
    y_target_label = tr["target_label"]
    y_off_rationale = tr["offensiveness_rationale"]
    y_target_rationale = tr["target_rationale"]  # 지금은 학습에 직접 쓰지 않지만(구조가 불명확), 나중에 확장 가능

    # -------------------------
    # 1) 벡터화
    # -------------------------
    vec = make_vectorizer()
    Xv = vec.fit_transform(X)

    # -------------------------
    # 2) Offensive binary (논문 1단계)
    #    normal=0, 나머지=1
    # -------------------------
    y_off = np.array([0 if v == "normal" else 1 for v in y_label], dtype=int)

    print("\nTraining offensive(binary) ...")
    clf_off = SGDClassifier(loss="log_loss", max_iter=25, tol=1e-3,
                            class_weight="balanced", random_state=42)
    clf_off.fit(Xv, y_off)
    W_off = clf_off.coef_.astype(np.float32)[0]
    b_off = np.float32(clf_off.intercept_[0])

    # -------------------------
    # 3) Target multi-label (논문 2단계: 타깃 존재/종류)
    #    target_label은 list[str] 형태라고 가정
    # -------------------------
    print("\nBuilding target labels ...")
    norm_targets = []
    for lst in y_target_label:
        out = []
        if lst:
            for t in lst:
                out.append(normalize_target(t))
        out = sorted(set(out))
        norm_targets.append(out)

    mlb_t = MultiLabelBinarizer(classes=TARGETS_CANON)
    YT = mlb_t.fit_transform(norm_targets).astype(int)  # (N, 9)

    print("Training target OVR (binary per target) ...")
    Wt = np.zeros((len(TARGETS_CANON), DIM), dtype=np.float32)
    bt = np.zeros((len(TARGETS_CANON),), dtype=np.float32)

    for j, tname in enumerate(TARGETS_CANON):
        yj = YT[:, j]
        pos = int(yj.sum())
        neg = int(len(yj) - pos)
        print(f"  target={tname:10s} pos={pos} neg={neg}")

        flag, forced_b = ensure_2class_binary_or_skip(yj)
        if flag is None:
            Wt[j] = 0.0
            bt[j] = np.float32(forced_b)
            print(f"    [skip-fit] only one class -> b={bt[j]}")
            continue

        clf = SGDClassifier(loss="log_loss", max_iter=20, tol=1e-3,
                            class_weight="balanced", random_state=42)
        clf.fit(Xv, yj)
        Wt[j] = clf.coef_.astype(np.float32)[0]
        bt[j] = np.float32(clf.intercept_[0])

    # -------------------------
    # 4) Fine-grained offensiveness (논문 3단계)
    #    offensiveness_rationale에서 태그 추출해 multi-label로 학습
    # -------------------------
    print("\nBuilding fine-grained tags from offensiveness_rationale ...")
    fine_tags = []
    for r in y_off_rationale:
        tags = sorted(extract_fine_tags(r))
        fine_tags.append(tags)

    mlb_f = MultiLabelBinarizer(classes=FINE_CANON)
    YF = mlb_f.fit_transform(fine_tags).astype(int)  # (N, 4)

    print("Training fine OVR (binary per fine axis) ...")
    Wf = np.zeros((len(FINE_CANON), DIM), dtype=np.float32)
    bf = np.zeros((len(FINE_CANON),), dtype=np.float32)

    for j, fname in enumerate(FINE_CANON):
        yj = YF[:, j]
        pos = int(yj.sum())
        neg = int(len(yj) - pos)
        print(f"  fine={fname:10s} pos={pos} neg={neg}")

        flag, forced_b = ensure_2class_binary_or_skip(yj)
        if flag is None:
            Wf[j] = 0.0
            bf[j] = np.float32(forced_b)
            print(f"    [skip-fit] only one class -> b={bf[j]}")
            continue

        clf = SGDClassifier(loss="log_loss", max_iter=20, tol=1e-3,
                            class_weight="balanced", random_state=42)
        clf.fit(Xv, yj)
        Wf[j] = clf.coef_.astype(np.float32)[0]
        bf[j] = np.float32(clf.intercept_[0])

    # -------------------------
    # 5) (선택) 4-class label classifier도 같이 export
    #    -> UI에서 참고용 확률로 보여주거나 fallback으로 사용 가능
    # -------------------------
    print("\nTraining 4-class label classifier (optional but useful) ...")
    clf_label = SGDClassifier(loss="log_loss", max_iter=25, tol=1e-3,
                              class_weight="balanced", random_state=42)
    clf_label.fit(Xv, y_label)
    classes = list(map(str, clf_label.classes_))
    W_label = clf_label.coef_.astype(np.float32)
    b_label = clf_label.intercept_.astype(np.float32)

    # -------------------------
    # export
    # -------------------------
    print("\nExporting to ./model ...")
    export_bin(W_off, "model/W_off.f32.bin")
    export_bin(np.array([b_off], np.float32), "model/b_off.f32.bin")

    export_bin(Wt, "model/W_target.f32.bin")   # (9, D)
    export_bin(bt, "model/b_target.f32.bin")   # (9,)

    export_bin(Wf, "model/W_fine.f32.bin")     # (4, D)
    export_bin(bf, "model/b_fine.f32.bin")     # (4,)

    export_bin(W_label, "model/W_label.f32.bin")  # (4, D)
    export_bin(b_label, "model/b_label.f32.bin")  # (4,)

    # Save vocabulary
    print("Exporting vocabulary ...")
    # Save vocabulary
    print("Exporting vocabulary ...")
    # Convert numpy int64 to python int for JSON serialization
    vocab_export = {k: int(v) for k, v in vec.vocabulary_.items()}
    with open("model/vocab.json", "w", encoding="utf-8") as f:
        json.dump(vocab_export, f, ensure_ascii=False)

    meta = {
        "dim": DIM,
        "labels": classes,            # label classifier class order
        "targets": TARGETS_CANON,     # target order
        "fine": FINE_CANON,           # fine axes order
        "b_off": float(b_off),
        "b_target": bt.tolist(),
        "b_fine": bf.tolist(),
        "b_label": b_label.tolist(),
        "vocab_file": "vocab.json",
        "vectorizer": {
            "type": "CountVectorizer",
            "analyzer": "char",
            "ngram_min": 3,
            "ngram_max": 5,
            "max_features": DIM,
            "lowercase": True
        }
    }
    with open("model/meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)

    print("\n✅ Done.")
    print("Created:")
    print("  model/meta.json")
    print("  model/vocab.json")
    print("  model/W_off.f32.bin, model/b_off.f32.bin")
    print("  model/W_target.f32.bin, model/b_target.f32.bin")
    print("  model/W_fine.f32.bin, model/b_fine.f32.bin")
    print("  model/W_label.f32.bin, model/b_label.f32.bin")

if __name__ == "__main__":
    main()
