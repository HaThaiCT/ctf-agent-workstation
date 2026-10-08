# Skills

Skills are discovered automatically from these sources, in override order:

1. This checkout `skills/` (even when `APP_ROOT_DIR` is elsewhere).
2. The category library [ljagiello/ctf-skills](https://github.com/ljagiello/ctf-skills),
   fetched once on startup into `APP_ROOT_DIR/cache/ctf-skills`.
3. App-root `skills/` and `all-skills/`, including uploaded skills.

Existing uploaded skills override same-name bundled entries and are never deleted
by automatic startup. A failed download is reported; bundled skills remain usable.

**Auto** selects the base evidence workflow plus skills matching challenge category
and file types. Unknown challenges expose category/tool workflows for discovery.
**Manual** uses exactly the chosen list (empty means none). Runs can inherit the
challenge policy, select Auto independently, or override it manually.

Selected directories are symlinked into run-local `.claude/skills` and
`.codex/skills` before every launch/resume. Claude explicitly enables project skill
discovery; Codex attaches only those workspace selections as structured skill
inputs. The native agent decides when to apply a discovered workflow.

## This Repo

### Forensics

| Skill | Domain | Key Tools |
|---|---|---|
| [tsk-disk-recovery](forensics/tsk-disk-recovery/SKILL.md) | Forensic disk recovery | TSK (mmls, fls, icat, fsstat), foremost, photorec, bulk_extractor |
| [file-repair-and-stego](forensics/file-repair-and-stego/SKILL.md) | File repair, stego, document dissection | exiftool, binwalk, zsteg, steghide, stegseek, olevba, oledump |
| [volatility3-memdump](forensics/volatility3-memdump/SKILL.md) | Full-system memory dump analysis | Volatility 3, mquire |
| [pcap-extraction](forensics/pcap-extraction/SKILL.md) | Packet capture extraction | tshark, tcpflow, scapy |

### Tools

| Skill | Domain | Key Tools |
|---|---|---|
| [apk-analysis](tools/apk-analysis/SKILL.md) | Android reverse engineering | jadx, apktool, IDA Pro |
| [analyze-with-ida-domain-api](tools/ida/SKILL.md) | Static binary analysis | IDA Pro Domain API (idalib, headless mode) |
| [kernel-gef-debugging](tools/kernel-gef/SKILL.md) | Kernel debugging | GDB + GEF via MCP |
| [craft-rop-chains-with-angrop](tools/angrop-rop-chains/SKILL.md) | ROP chain building (pwn) | angr + angrop |

## External (ljagiello/ctf-skills)

Cached automatically on app startup. Provisioning may also populate `all-skills/`
with `install_scripts/013_install-skills.sh`; do not rerun that destructive catalog
rebuild to refresh the running app.

| Skill | Category |
|---|---|
| ctf-crypto | Cryptography (RSA, AES, ECC, lattices, PRNGs, stream ciphers) |
| ctf-pwn | Binary exploitation (stack, heap, ROP, kernel, format string) |
| ctf-reverse | Reverse engineering (ELF, PE, custom VMs, WASM, anti-analysis) |
| ctf-web | Web exploitation (SQLi, SSTI, JWT, OAuth, deserialization, Web3) |
| ctf-misc | Mixed challenges (sandbox escapes, encodings, privilege escalation) |
| ctf-osint | Open-source intelligence (geolocation, social media) |
| ctf-malware | Malware analysis (obfuscated scripts, C2, dynamic analysis) |
| ctf-ai-ml | AI/ML challenges (model attacks, adversarial examples, LLM attacks) |
