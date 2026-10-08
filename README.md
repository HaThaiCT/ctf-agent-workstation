# CTF Agent Orchestrator (CTF Solver Workstation)

Hệ thống trạm làm việc (Workstation) tự động hóa giải thử thách CTF (Capture The Flag) ứng dụng trí tuệ nhân tạo (AI Agent). Nền tảng tích hợp sẵn kho công cụ an ninh mạng thực tế (Reverse Engineering, Pwn/Exploitation, Forensics, Crypto, Web), cho phép điều phối các AI Agent hàng đầu — **Claude Code** và **Codex** — thông qua giao diện Web thời gian thực hoặc Discord Bot.

```
┌─────────────────┐       Tạo / Chọn bài       ┌────────────────────────┐      Thực thi Native      ┌─────────────────────────────┐
│  Web UI 8000 /  │ ─────────────────────────► │   Webapp (Starlette)   │ ────────────────────────► │ Claude Code / Codex (Local) │
│   Discord Bot   │ ◄───────────────────────── │ State · JSONL · Stream │ ◄──────────────────────── │  + Bộ công cụ CTF & GDB MCP │
└─────────────────┘      WebSocket Stream      └────────────────────────┘       Events / Tool calls └─────────────────────────────┘
                                                           │
                                                           ▼
                                                ┌───────────────────────┐
                                                │ 9router Local (:20128)│
                                                │ Quản lý Model & Effort│
                                                └───────────────────────┘
```

---

## Mục lục

1. [Tổng quan & Nguyên lý hoạt động](#1-tổng-quan--nguyên-lý-hoạt-động)
2. [Chi tiết các tính năng chính](#2-chi-tiết-các-tính-năng-chính)
   - [2.1. Cổng định tuyến AI Model (9router Gateway)](#21-cổng-định-tuyến-ai-model-9router-gateway)
   - [2.2. Khởi tạo phiên 2 lượt (Two-Turn Persona Initiation)](#22-khởi-tạo-phiên-2-lượt-two-turn-persona-initiation)
   - [2.3. Quản lý thử thách & Phiên giải (Challenge Lifecycle)](#23-quản-lý-thử-thách--phiên-giải-challenge-lifecycle)
   - [2.4. Chế độ giải bài & Phối hợp đồng đội (Single & Parallel Racing)](#24-chế-độ-giải-bài--phối-hợp-đồng-đội-single--parallel-racing)
   - [2.5. Hệ thống Kỹ năng (CTF Skills) & Debugger MCP](#25-hệ-thống-kỹ-năng-ctf-skills--debugger-mcp)
   - [2.6. Giao diện Web thời gian thực (Real-time Web UI)](#26-giao-diện-web-thời-gian-thực-real-time-web-ui)
   - [2.7. Trợ lý cố vấn chiến thuật (Advisor AI)](#27-trợ-lý-cố-vấn-chiến-thuật-advisor-ai)
   - [2.8. Tích hợp Discord Bot](#28-tích-hợp-discord-bot)
3. [Tài nguyên hệ thống & Mức độ chiếm dụng](#3-tài-nguyên-hệ-thống--mức-độ-chiếm-dụng)
4. [Cài đặt & Khởi chạy nhanh](#4-cài-đặt--khởi-chạy-nhanh)
5. [Cấu trúc thư mục dự án](#5-cấu-trúc-thư-mục-dự-án)

---

## 1. Tổng quan & Nguyên lý hoạt động

Nhiều AI Agent hiện nay có khả năng suy luận và khai thác lỗ hổng rất tốt, nhưng nút thắt lớn nhất là **môi trường thực thi**. Một agent cần quyền truy cập shell Linux thật, các trình dịch ngược, trình gỡ lỗi, thư viện phân tích mã nhị phân, và khả năng chạy các script khai thác mà không bị hạn chế bởi sandbox hẹp.

**CTF Agent Orchestrator** giải quyết vấn đề này bằng cách:
* **Môi trường cục bộ thực tế (Bare-metal Execution):** Mọi lệnh của agent đều chạy trực tiếp trên hệ thống Ubuntu với đầy đủ bộ công cụ: `gdb` (kèm `gef`/`pwndbg`), `pwntools`, `angr`, `z3`, `volatility3`, `tshark`, `binwalk`, `hashcat`, `john`, `apktool`, `bulk_extractor`, v.v.
* **Tích hợp 9router Local:** Định tuyến tập trung toàn bộ request mô hình qua 9router local (`http://127.0.0.1:20128/v1`), hỗ trợ chọn linh hoạt giữa hàng chục model (GPT-6, DeepSeek-V4, Claude 3.7/Sonnet, Gemini...) và kiểm soát mức độ suy nghĩ (`effort`).
* **Hỗ trợ Agent Đa Nền tảng:** Sử dụng bản native chính thức của **Claude Code** (qua `claude-agent-sdk`) và **Codex** (qua `codex app-server` JSON-RPC).

---

## 2. Chi tiết các tính năng chính

### 2.1. Cổng định tuyến AI Model (9router Gateway)
Hệ thống kết nối trực tiếp với 9router daemon cục bộ để cấp quyền truy cập mô hình cho tất cả các solver:
* **Tự động khám phá (Auto-discovery):** Tự tìm kiếm API key và native launcher từ `~/Documents/Codex/runtime/9router-clients/` mà không bắt buộc cấu hình biến môi trường thủ công hay đăng nhập tài khoản qua trình duyệt.
* **Danh mục động (>60+ Models):** Tự động fetch danh sách model trực tiếp từ 9router. Giữ nguyên định danh chính xác (vd: `cx/gpt-6.1-sol`, `cmc/deepseek/deepseek-v4-pro`, `ag/claude-sonnet-4-6`).
* **Kiểm soát Reasoning Effort chuyên sâu:**
  * **Selectable:** Cho phép chọn giữa 5 mức độ suy luận chuẩn: `low`, `medium`, `high`, `xhigh`, `max` (dành cho các model OpenAI Reasoning / DeepSeek).
  * **Provider-managed / Fixed:** Đối với các model Anthropic qua proxy hoặc biến thể Gemini fixed alias, giao diện tự động khoá dropdown và ghi chú rõ lý do kỹ thuật thay vì giả lập mức độ không được hỗ trợ.
* **Cách ly cấu hình:** Chỉ truyền cấu hình gateway qua biến môi trường của tiến trình con (`child env`), tuyệt đối không ghi đè cấu hình native toàn cục của máy (`~/.claude/settings.json` hay `~/.codex/config.toml`).

---

### 2.2. Khởi tạo phiên 2 lượt (Two-Turn Persona Initiation)
Nhằm đảm bảo agent tuân thủ chặt chẽ phong cách giải đề và nguyên tắc an toàn, hệ thống hỗ trợ cơ chế nạp chỉ dẫn khởi tạo:
* **Tự động đọc `instruction.txt`:** Hệ thống quét file `instruction.txt` ở thư mục gốc ứng dụng khi bắt đầu một phiên làm việc mới.
* **Lượt 1 (Prompt Khởi tạo):** Agent nhận chỉ dẫn từ `instruction.txt` trước tiên để thiết lập persona, nguyên tắc phân tích và phong cách làm việc. Agent gửi phản hồi xác nhận khởi tạo.
* **Lượt 2 (Lệnh giải bài CTF):** Ngay sau khi Lượt 1 hoàn tất, hệ thống tự động giữ nguyên phiên (`session_id`/`thread_id`) và đưa tiếp prompt đề bài cùng đường dẫn thư mục bài tập để agent bắt đầu hành động.
* **Bảo toàn ngữ cảnh:** Khi người dùng sử dụng tính năng **Steer** (nhắc bài) hoặc **Resume**, agent tiếp tục trò chuyện trong ngữ cảnh đã có mà không cần lặp lại lượt khởi tạo.

---

### 2.3. Quản lý thử thách & Phiên giải (Challenge Lifecycle)
* **Tạo bài tập linh hoạt:**
  * **Single Challenge:** Nhập thủ công tên, mô tả, định dạng cờ (`flag_format`), thể loại và tải lên file đính kèm.
  * **Bulk Upload:** Tải lên file nén `.zip` hoặc `.7z` chứa nhiều bài tập, cho phép xem trước và tinh chỉnh trước khi nạp vào hệ thống.
  * **Platform Import:** Đồng bộ bài thi tự động từ các nền tảng: **CTFd, rCTF, Hack The Box (HTB), CDDC, Cywaria/Cympire, SAS CTF, GPN**. Hỗ trợ lưu thông tin kết nối và tự động re-sync điểm số/số lượt giải.
* **On-Demand Remote Instances:** Tự động gửi tín hiệu bật container Docker/máy ảo từ xa (đối với các bài HTB, Cywaria, SAS) ngay trước khi giải và tự động chèn IP/port kết nối vào prompt cho agent.
* **Chế độ Chọn & Xóa hàng loạt:**
  * Nút **Select** trên Header cho phép chuyển sang chế độ chọn nhiều bài tập.
  * Nút **Delete Selected** xoá an toàn các bài tập đã chọn cùng toàn bộ workspace và tiến trình đang chạy.
  * Nút **Download Zip** tải về toàn bộ tệp và nhật ký của các bài đã chọn.
  * Nút **Clear All** cho phép dọn sạch toàn bộ các bài tập và phiên giải trên hệ thống với hộp thoại xác nhận bảo vệ.

---

### 2.4. Chế độ giải bài & Phối hợp đồng đội (Single & Parallel Racing)
* **Chế độ đơn lẻ (Single Mode):** Một agent tập trung phân tích bài tập từ đầu đến cuối.
* **Chế độ chạy đua song song (Parallel Mode):**
  * Gán nhiều agent cùng lúc (ví dụ: Claude Code chạy model Claude kết hợp Codex chạy model GPT-6).
  * Mỗi agent sở hữu một workspace độc lập trong thư mục `_runs/<run_id>/` để tránh ghi đè file của nhau.
  * **Working Notes & Phối hợp đồng đội:** Tự động liên kết mềm (`symlink`) file `WORKING_NOTES.md` giữa các agent. Agent có thể sử dụng tool `notify_teammates` để thông báo khi tìm thấy manh mối đột phá.
  * **Auto-stop Siblings:** Ngay khi một agent tìm thấy và nộp cờ chính xác, toàn bộ các agent khác đang giải cùng bài sẽ tự động dừng lại để tiết kiệm chi phí/tài nguyên.
* **Can thiệp thời gian thực (Interactive Controls):**
  * **Steer:** Gửi chỉ dẫn bổ sung, gợi ý hoặc sửa sai cho agent ngay giữa phiên giải.
  * **Stop:** Dừng ngay tiến trình agent đang chạy.
  * **Resume / Retry:** Tiếp tục phiên đã dừng hoặc bắt đầu lại từ đầu với một session mới tinh.
  * **Mark Solved / Unsolve:** Đánh dấu trạng thái bài tập thủ công khi cần.

---

### 2.5. Hệ thống Kỹ năng (CTF Skills) & Debugger MCP
Hệ thống sử dụng các tài liệu phương pháp luận (`SKILL.md`) để định hướng quy trình giải bài cho agent:
* **Kho kỹ năng chuyên sâu:**
  * **Forensics:** Phân tích bộ nhớ Linux/Windows (`volatility3`), phân tích packet (`tshark`), trích xuất dữ liệu ẩn (`stego`, `binwalk`, `bulk_extractor`).
  * **Pwn / Binary Exploitation:** Kỹ thuật khai thác stack, heap, tạo chuỗi ROP tự động (`angrop`), kernel exploitation, bảo vệ canary/ASLR.
  * **Reverse Engineering:** Tự động hoá với `angr`, decompile với Ghidra / IDA Pro headless API, phân tích ứng dụng Android (`apktool`).
  * **Web & Crypto:** Tấn công JWT, padding oracle, RSA, elliptic curve, tấn công lattice/LLL với Sagemath.
* **Cơ chế nạp kỹ năng:**
  * **Chế độ Auto:** Tự động nhận diện category bài tập và các định dạng file (`.pcap`, `.elf`, `.apk`, `.mem`) để symlink đúng các skill cần thiết vào thư mục `.claude/skills` hoặc `.codex/skills`.
  * **Chế độ Manual:** Cho phép người dùng tick chọn chính xác từng skill cho bài tập.
* **Persistent GDB MCP Server:** Cung cấp sẵn server FastMCP kết nối trực tiếp với GDB trên máy, cho phép agent đặt breakpoint, đọc thanh ghi, kiểm tra bộ nhớ trực tiếp trong session Claude/Codex.

---

### 2.6. Giao diện Web thời gian thực (Real-time Web UI)
Giao diện đơn trang hiện đại, phục vụ trực tiếp qua cổng `http://127.0.0.1:8000`:
* **WebSocket Live Stream:** Truyền tải luồng phản hồi tức thì gồm: khối suy nghĩ (`thinking`), các lệnh bash đang chạy, output terminal, và tin nhắn trò chuyện.
* **Trình duyệt File tích hợp (File Viewer):** Xem trực tiếp file đề bài và sản phẩm trong workspace của agent: hiển thị ảnh, làm nổi bật cú pháp file mã nguồn, và chế độ xem Hex (`Hex Viewer`) cho các file binary.
* **Bắt cờ tự động (Flag Detection):**
  * Tự động quét regex cho các định dạng: `flag{...}`, `CTF{...}`, `HTB{...}`, `picoCTF{...}` hoặc định dạng tuỳ chỉnh.
  * **Silent `ctfgrep` Preflight:** Tự động quét chuỗi nhị phân trong file đề bài trước khi agent bắt đầu; nếu cờ nằm sẵn trong file plain text/strings, hệ thống sẽ phát hiện ngay lập tức.
  * **Auto-submit:** Tự động gửi cờ lên nền tảng CTF đã kết nối và cập nhật điểm số.
* **Bảng điều khiển Usage & Thống kê:** Hiển thị chi tiết số lượng token đầu vào/đầu ra, thời gian xử lý, số lượt tool call và trạng thái kết nối của từng harness.

---

### 2.7. Trợ lý cố vấn chiến thuật (Advisor AI)
* **Advisor Panel:** Mỗi bài tập có một khung trò chuyện với cố vấn riêng biệt.
* Cố vấn có quyền đọc toàn bộ log hoạt động và transcript hiện tại của các solver đang chạy, giải đáp thắc mắc của bạn về bài thi, tra cứu CVE/kỹ thuật liên quan trên Internet, và có thể gửi các gợi ý súc tích trực tiếp vào phiên giải của solver.

---

### 2.8. Tích hợp Discord Bot (Tuỳ chọn)
* Cấu hình Discord Bot Token trong mục **Settings**.
* Tự động tạo channel hoặc thread riêng cho từng challenge.
* Thông báo tức thì khi agent bắt đầu, tìm thấy cờ, giải thành công hoặc dừng lại.
* Hỗ trợ Slash Commands để điều khiển từ xa: `/ctf`, `/status`, `/flags`, `/submit`, `/steer`, `/resume`, `/stop`.

---

## 3. Tài nguyên hệ thống & Mức độ chiếm dụng

Hệ thống được tối ưu hóa để chạy mượt mà ngay trên các máy có cấu hình tiêu chuẩn (8 Core CPU, 8 GB RAM):

| Thành phần | Mức RAM chiếm dụng | Mức CPU | Đặc điểm hoạt động |
| :--- | :--- | :--- | :--- |
| **Webapp Backend (`ctf-solver`)** | ~110 MB | < 1% | Server Uvicorn/Starlette xử lý API & WebSocket |
| **9router Daemon** | ~20 - 30 MB | ~0% | Proxy HTTP định tuyến request sang mô hình |
| **Tiến trình Claude Code (Mỗi run)** | ~90 - 200 MB | < 5% | Phần lớn thời gian đợi stream mạng từ 9router |
| **Tiến trình Codex (Mỗi run)** | ~120 - 250 MB | < 5% | Chạy chế độ `app-server` JSON-RPC qua stdio |
| **Công cụ CTF thường (gdb, pwntools, tshark)** | ~50 - 250 MB | Thấp | Chạy theo từng tool call cụ thể |
| **Công cụ CTF nặng (`angr`, `volatility3`, `z3`)** | 1.0 - 2.5 GB | 100% (1-2 core) | Chỉ tăng cao khi agent chạy symbolic execution hoặc quét dump bộ nhớ lớn |

*Khuyến nghị:* Nên chạy 1 đến 2 agent song song trên máy cục bộ để đảm bảo an toàn bộ nhớ.

---

## 4. Cài đặt & Khởi chạy nhanh

### Yêu cầu hệ thống
* Hệ điều hành: **Ubuntu 24.04 LTS x86_64** (hoặc Debian 12+)
* Python: **3.12+**
* Node.js: **v20+**
* Daemon **9router** đang chạy trên máy (mặc định tại `http://127.0.0.1:20128/v1`).

### Khởi động dịch vụ
Ứng dụng đã được cấu hình systemd user service trên máy:
```bash
# Khởi động hoặc khởi động lại dịch vụ
systemctl --user restart ctf-solver.service

# Kiểm tra trạng thái hoạt động
systemctl --user status ctf-solver.service
```

Hoặc khởi chạy trực tiếp qua script:
```bash
cd webapp
./start.sh
```

Truy cập giao diện Web tại: **`http://127.0.0.1:8000`**

### Quy trình giải bài mẫu
1. Mở trình duyệt tại `http://127.0.0.1:8000`.
2. Bấm **+ Add Challenge** -> Chọn **Add Single Challenge**.
3. Điền tên bài, mô tả, tải lên file đính kèm.
4. Chọn Harness (**Claude** hoặc **Codex**), chọn Model từ danh sách 9router (vd: `cmc/deepseek/deepseek-v4-pro` hoặc `cx/gpt-6.1-sol`) và mức Effort mong muốn.
5. Bấm **Create & Solve**:
   * Hệ thống tự động gửi prompt từ `instruction.txt` khởi tạo agent (Lượt 1).
   * Agent phản hồi và nhận tiếp đề bài CTF (Lượt 2).
   * Bạn theo dõi trực tiếp quá trình agent gõ lệnh, phân tích mã nguồn và giải mã cờ theo thời gian thực.
6. Khi tìm thấy cờ, hệ thống tự động bôi đậm cờ và đánh dấu bài tập là **Solved**.

---

## 5. Cấu trúc thư mục dự án

```text
ctf-agent-workstation/
├── webapp/                 # Backend Starlette ASGI & bộ điều phối trung tâm
│   ├── app.py              # Xử lý route, streaming, lifecycle và quản lý file
│   ├── model_gateway.py    # Tích hợp 9router local, catalog động & effort policy
│   ├── agents/             # Adapter cho Claude Code (SDK) và Codex (app-server)
│   ├── plugins/            # Plugin tích hợp các nền tảng CTF (CTFd, HTB, SAS...)
│   └── static/             # Frontend HTML/CSS/JavaScript thuần (không cần build)
├── skills/                 # Thư viện CTF Skills (Forensics, Pwn, Reversing, Crypto)
├── mcps/                   # MCP server (FastMCP GDB debugger)
├── install_scripts/        # Bộ script cài đặt công cụ an ninh mạng tự động
├── infra/                  # Terraform template triển khai lên Hetzner / DO / GCP
├── instruction.txt         # File prompt khởi tạo persona & quy tắc ban đầu cho agent
└── README.md               # Tài liệu hướng dẫn sử dụng chi tiết
```
