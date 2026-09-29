"""Mutation run (ARB-DESIGN r9 section 7.1). Applies one mutation at a time to a pristine copy of src/,
runs the full Foundry suite, and requires it to FAIL. Restores by copying the backup (never git checkout).

    python3 mutation/run.py            # from evm/
"""
import json, os, shutil, subprocess, sys, tempfile, time

EVM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(EVM)
muts = json.load(open("mutation/mutations.json"))
only = set(sys.argv[1:])
backup = tempfile.mkdtemp(prefix="othello-mut-")
shutil.copytree("src", os.path.join(backup, "src"))


def restore():
    shutil.rmtree("src")
    shutil.copytree(os.path.join(backup, "src"), "src")


# Baseline must pass, or a "killed" result means nothing.
base = subprocess.run(["forge", "test", "--fail-fast"], capture_output=True, text=True)
if base.returncode != 0:
    print(base.stdout[-3000:])
    sys.exit("baseline suite fails; fix it before mutating")
print("baseline: suite passes")

results = []
try:
    for mu in muts:
        if only and mu["id"] not in only:
            continue
        src = open(mu["file"]).read()
        if src.count(mu["find"]) != 1:
            results.append((mu["id"], "BAD-PATTERN", mu["rule"]))
            print(f"{mu['id']} BAD-PATTERN ({src.count(mu['find'])} matches) {mu['rule']}")
            continue
        open(mu["file"], "w").write(src.replace(mu["find"], mu["replace"]))
        t0 = time.time()
        r = subprocess.run(["forge", "test", "--fail-fast"], capture_output=True, text=True)
        restore()
        if "Compiler run failed" in r.stdout + r.stderr:
            status = "COMPILE-ERROR"
        elif r.returncode != 0:
            status = "killed"
        else:
            status = "SURVIVED"
        want = mu.get("expect", "killed")
        ok = status == "killed" or (status == "SURVIVED" and want == "survivor-unreachable")
        results.append((mu["id"], status, mu["rule"]))
        print(f"{mu['id']} {status:13s} {'ok ' if ok else 'BAD'} {time.time() - t0:5.0f}s  {mu['rule']}", flush=True)
finally:
    restore()
    shutil.rmtree(backup)
    # out/ still holds the last MUTATED build; rebuild so nothing later (ABI export, anvil specs) uses it
    subprocess.run(["forge", "build"], capture_output=True, text=True, check=True)

bad = [r for r in results if r[1] not in ("killed",) and not (r[1] == "SURVIVED" and next(
    m for m in muts if m["id"] == r[0]).get("expect") == "survivor-unreachable")]
print(f"\n{len(results)} mutations, {sum(1 for r in results if r[1] == 'killed')} killed, {len(bad)} bad")
sys.exit(1 if bad else 0)
