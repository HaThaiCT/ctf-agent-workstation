---
name: rizin-disassembly
description: Disassemble, inspect, and analyze binary executables using Rizin (rz-bin, rz-diff, rizin) and rz-ghidra. Use for fast command-line binary analysis, function disassembly, decompilation, and strings inspection on Kali/Linux.
---

# Rizin Binary Analysis & Disassembly

Rizin is a fast, UNIX-friendly reverse engineering framework. Use it for automated and scripted binary inspection.

## Quick Command-Line Workflow

Run non-interactive queries with `rizin -q -c '<commands>' <binary>`.

### 1. Analyze and List Functions
```bash
# Analyze everything (aaa) and list functions (afl)
rizin -q -c "aaa; afl" ./chall.bin
```

### 2. Disassemble a Function
```bash
# Analyze and print disassembly of main (pdf @ main)
rizin -q -c "aaa; pdf @ main" ./chall.bin

# Print disassembly of a specific function or entrypoint
rizin -q -c "aaa; pdf @ entry0" ./chall.bin
```

### 3. Decompile with rz-ghidra (if installed)
```bash
# Print decompiled C code for main
rizin -q -c "aaa; pdg @ main" ./chall.bin
```

### 4. Binary Headers, Sections, and Strings
```bash
# Binary info (architecture, bits, endianness, protections)
rz-bin -I ./chall.bin

# Strings in data sections
rz-bin -z ./chall.bin

# Entire file strings
rz-bin -zz ./chall.bin

# Imports and exports
rz-bin -i ./chall.bin
rz-bin -E ./chall.bin
```

### 5. Scripted Rizin Python Automation (rzpipe)
```python
import rzpipe

rz = rzpipe.open("./chall.bin")
rz.cmd("aaa")
functions = rz.cmdj("aflj")  # JSON output
for f in functions:
    print(f["name"], hex(f["offset"]))
disasm = rz.cmd("pdf @ main")
print(disasm)
rz.quit()
```
