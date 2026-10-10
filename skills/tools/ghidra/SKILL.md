---
name: ghidra-headless-decompilation
description: Decompile and analyze binaries using Ghidra in headless mode (analyzeHeadless). Use for binary analysis, decompiling functions to C pseudocode, extracting symbol tables, and cross-references when GUI is unavailable or when IDA license is absent.
---

# Ghidra Headless Analysis and Decompilation

Use this skill to analyze binaries, extract decompiled C functions, and inspect program structure using Ghidra's headless analyzer.

## Basic Usage with analyzeHeadless

Ghidra provides `analyzeHeadless` (typically at `/usr/bin/analyzeHeadless` or `/opt/ghidra/support/analyzeHeadless`).

### 1. Quick Decompilation / Function Export

To analyze a binary and run a post-analysis Python/Java script:

```bash
# Basic project creation and analysis
analyzeHeadless /tmp/ghidra_proj temp_proj -import ./chall.bin -overwrite -postScript Decompile.py
```

### 2. Standalone PyGhidra or Ghidra Bridge

If `pyghidra` is installed:

```python
import pyghidra
with pyghidra.open_program("chall.bin") as prog:
    decomp = prog.decompile("main")
    print(decomp)
```

### 3. Ghidra Decompiler Script Pattern

Create a small headless script (e.g. `dump_all_functions.py`):

```python
# dump_all_functions.py (run with -postScript dump_all_functions.py)
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

monitor = ConsoleTaskMonitor()
decompiler = DecompInterface()
decompiler.openProgram(currentProgram)

fm = currentProgram.getFunctionManager()
for func in fm.getFunctions(True):
    name = func.getName()
    res = decompiler.decompileFunction(func, 30, monitor)
    if res.decompileCompleted():
        print(f"// Function: {name}")
        print(res.getDecompiledFunction().getC())
```

Run with:
```bash
analyzeHeadless /tmp/ghidra_tmp proj -import ./chall.bin -postScript dump_all_functions.py -deleteProject
```
