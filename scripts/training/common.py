"""Shared helpers for the Astro Health dataset/training experiments (scripts/training/).

Everything runs locally on the CPU. Nothing here uploads anything: downloads are plain GETs of
public files, and no recording or photo of the user is ever read by these scripts.

    manifest      data/training/MANIFEST.json -- one entry per dataset: source, license, version,
                  download date, counts (record() adds or replaces an entry)
    RemoteFile    a seekable, read-only file over HTTP Range requests, so zipfile can pull ONE
                  member out of a big public archive without downloading all of it
    metrics()     accuracy, balanced accuracy, macro precision/recall/F1, per-class report,
                  confusion matrix -- numpy only (scikit-learn is not installed, and isn't needed)
    train_head()  a small softmax classifier (linear or one hidden layer) with class weights,
                  small batches, early stopping on validation macro-F1, a checkpoint and a log
"""
import datetime as _dt
import hashlib
import io
import json
import os
import random
import time
import urllib.request

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TRAINING = os.path.join(REPO, "data", "training")
REPORTS = os.path.join(TRAINING, "reports")
CANDIDATES = os.path.join(REPO, "models", "candidates")
MANIFEST = os.path.join(TRAINING, "MANIFEST.json")
USER_AGENT = "astro-health-research/1.0"  # generic client name, nothing personal
SEED = 1234


def seed_everything(seed=SEED):
    random.seed(seed)
    np.random.seed(seed)
    try:
        import torch
        torch.manual_seed(seed)
    except ImportError:
        pass


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------- manifest

def load_manifest():
    if os.path.isfile(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    return {"note": "Datasets used by scripts/training/. Raw files are local only (gitignored).", "datasets": {}}


def record(key, entry):
    m = load_manifest()
    m["datasets"][key] = {**m["datasets"].get(key, {}), **entry}
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write("\n")


def write_report(name, data):
    os.makedirs(REPORTS, exist_ok=True)
    path = os.path.join(REPORTS, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=float)
        f.write("\n")
    return path


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sha1_bytes(b):
    return hashlib.sha1(b).hexdigest()


# ------------------------------------------------------------------------------- HTTP

def http_get(url, timeout=60, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class RemoteFile(io.RawIOBase):
    """Read-only, seekable view of a remote file through HTTP Range requests (with a small
    read-ahead cache). Enough for zipfile.ZipFile to list an archive and extract one member."""

    def __init__(self, url, chunk=1 << 20):
        self.url, self.chunk, self.pos = url, chunk, 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            if r.headers.get("Accept-Ranges", "").lower() != "bytes":
                raise RuntimeError("server does not support range requests")
            self.size = int(r.headers["Content-Length"])
        self.cache_start, self.cache = -1, b""
        self.fetched = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def _fetch(self, start, end):
        for attempt in range(4):
            try:
                data = http_get(self.url, headers={"Range": f"bytes={start}-{end - 1}"}, timeout=120)
                self.fetched += len(data)
                return data
            except Exception:  # noqa: BLE001 -- retry transient network errors
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        cs, ce = self.cache_start, self.cache_start + len(self.cache)
        if not (cs <= self.pos and self.pos + n <= ce):
            start = self.pos
            end = min(self.size, start + max(n, self.chunk))
            self.cache_start, self.cache = start, self._fetch(start, end)
            cs = start
        out = self.cache[self.pos - cs:self.pos - cs + n]
        self.pos += len(out)
        return out

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


# ------------------------------------------------------------------------------- metrics

def metrics(y_true, y_pred, labels):
    """labels: list of class names; y_true/y_pred: int arrays of indices into labels
    (a prediction of -1 = 'outside the label set', counted as wrong for every class)."""
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    k = len(labels)
    cm = np.zeros((k, k + 1), dtype=int)  # last column: predictions outside the label set
    for t, p in zip(y_true, y_pred):
        cm[t, p if 0 <= p < k else k] += 1
    per = {}
    for i, name in enumerate(labels):
        tp = cm[i, i]
        fp = cm[:, i].sum() - tp
        fn = cm[i, :].sum() - tp
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        per[name] = {"precision": round(float(prec), 4), "recall": round(float(rec), 4), "f1": round(float(f1), 4), "support": int(cm[i, :].sum())}
    present = [n for n in labels if per[n]["support"] > 0]
    return {
        "n": int(len(y_true)),
        "accuracy": round(float((y_true == y_pred).mean()) if len(y_true) else 0.0, 4),
        "balanced_accuracy": round(float(np.mean([per[n]["recall"] for n in present])) if present else 0.0, 4),
        "macro_precision": round(float(np.mean([per[n]["precision"] for n in present])) if present else 0.0, 4),
        "macro_recall": round(float(np.mean([per[n]["recall"] for n in present])) if present else 0.0, 4),
        "macro_f1": round(float(np.mean([per[n]["f1"] for n in present])) if present else 0.0, 4),
        "per_class": per,
        "labels": list(labels),
        "confusion_matrix": cm[:, :k].tolist() if not cm[:, k].any() else cm.tolist(),
        "confusion_matrix_note": "rows = true, columns = predicted" + (" (+ last column: predicted a label outside this set)" if cm[:, k].any() else ""),
    }


def bootstrap_diff(y_true, pred_a, pred_b, labels, n=1000, groups=None, seed=SEED):
    """95% CI of macro-F1(b) - macro-F1(a) by resampling (by group, e.g. speaker, if given)."""
    rng = np.random.default_rng(seed)
    y_true, pred_a, pred_b = map(np.asarray, (y_true, pred_a, pred_b))
    idx_by_group = None
    if groups is not None:
        groups = np.asarray(groups)
        uniq = np.unique(groups)
        idx_by_group = [np.where(groups == g)[0] for g in uniq]
    diffs = []
    for _ in range(n):
        if idx_by_group is not None:
            pick = rng.integers(0, len(idx_by_group), len(idx_by_group))
            idx = np.concatenate([idx_by_group[i] for i in pick])
        else:
            idx = rng.integers(0, len(y_true), len(y_true))
        a = metrics(y_true[idx], pred_a[idx], labels)["macro_f1"]
        b = metrics(y_true[idx], pred_b[idx], labels)["macro_f1"]
        diffs.append(b - a)
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return {"mean": round(float(np.mean(diffs)), 4), "ci95": [round(float(lo), 4), round(float(hi), 4)], "resamples": n,
            "unit": "group" if groups is not None else "sample"}


# ------------------------------------------------------------------------------- a small head

def train_head(Xtr, ytr, Xva, yva, n_classes, hidden=0, lr=1e-3, weight_decay=1e-3, batch=32,
               max_epochs=200, patience=15, threads=4, log_path=None, seed=SEED):
    """A softmax classifier on fixed features: standardised inputs, class-weighted loss (for
    imbalance), small batches, early stopping on validation macro-F1. Returns (model_dict, log).
    model_dict holds plain numpy weights + the standardisation, so it can be saved as .npz and
    run without torch."""
    import torch
    torch.set_num_threads(threads)
    seed_everything(seed)
    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-6
    f = lambda X: torch.tensor((X - mu) / sd, dtype=torch.float32)  # noqa: E731
    xtr, xva = f(Xtr), f(Xva)
    ttr = torch.tensor(ytr, dtype=torch.long)
    counts = np.bincount(ytr, minlength=n_classes).astype(float)
    w = torch.tensor(counts.sum() / (n_classes * np.maximum(counts, 1)), dtype=torch.float32)
    d = Xtr.shape[1]
    if hidden:
        net = torch.nn.Sequential(torch.nn.Linear(d, hidden), torch.nn.ReLU(), torch.nn.Dropout(0.2), torch.nn.Linear(hidden, n_classes))
    else:
        net = torch.nn.Sequential(torch.nn.Linear(d, n_classes))
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=weight_decay)
    loss_fn = torch.nn.CrossEntropyLoss(weight=w)
    best, best_state, bad, log = -1.0, None, 0, []
    labels = list(range(n_classes))
    t0 = time.time()
    for epoch in range(max_epochs):
        net.train()
        perm = torch.randperm(len(xtr))
        total = 0.0
        for i in range(0, len(perm), batch):
            j = perm[i:i + batch]
            opt.zero_grad()
            loss = loss_fn(net(xtr[j]), ttr[j])
            loss.backward()
            opt.step()
            total += loss.item() * len(j)
        net.eval()
        with torch.no_grad():
            pva = net(xva).argmax(1).numpy()
        f1 = metrics(yva, pva, labels)["macro_f1"]
        log.append({"epoch": epoch + 1, "train_loss": round(total / len(xtr), 4), "val_macro_f1": f1})
        if f1 > best + 1e-4:
            best, bad = f1, 0
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    net.load_state_dict(best_state)
    if log_path:
        with open(log_path, "w", encoding="utf-8") as fh:
            for row in log:
                fh.write(json.dumps(row) + "\n")
    layers = [m for m in net if isinstance(m, torch.nn.Linear)]
    model = {"mu": mu, "sd": sd, "hidden": hidden}
    for i, L in enumerate(layers):
        model[f"W{i}"] = L.weight.detach().numpy().T.copy()
        model[f"b{i}"] = L.bias.detach().numpy().copy()
    return model, {"epochs_run": len(log), "best_val_macro_f1": best, "seconds": round(time.time() - t0, 1),
                   "params": {"hidden": hidden, "lr": lr, "weight_decay": weight_decay, "batch": batch, "patience": patience,
                              "max_epochs": max_epochs, "threads": threads, "seed": seed, "class_weights": w.tolist()}}


def head_predict_proba(model, X):
    z = (X - model["mu"]) / model["sd"]
    if model.get("hidden"):
        z = np.maximum(z @ model["W0"] + model["b0"], 0)
        z = z @ model["W1"] + model["b1"]
    else:
        z = z @ model["W0"] + model["b0"]
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)
