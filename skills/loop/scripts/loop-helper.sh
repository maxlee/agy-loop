#!/bin/sh
# Deterministic POSIX helper for the agy-loop (/loop) skill.
# Zero bashisms, zero Node/Python dependencies.

set -eu

SUBCMD="${1:-}"
if [ -n "${1+x}" ]; then
  shift
fi

normalize_dir() {
  _nd="${1:-$PWD}"
  if [ -z "$_nd" ]; then
    _nd="$PWD"
  fi
  while [ "$_nd" != "/" ] && [ "${_nd%/}" != "$_nd" ]; do
    _nd="${_nd%/}"
  done
  printf '%s' "$_nd"
}

run_parse() {
  _use_stdin=0
  if [ "$#" -eq 1 ] && [ "$1" = "--stdin" ]; then
    _use_stdin=1
    shift
  fi

  LP_STDIN="$_use_stdin" POSIXLY_CORRECT=1 LC_ALL=C awk '
    function init_tables(    i, c) {
      for (i = 1; i < 256; i++) {
        ord[sprintf("%c", i)] = i
      }
      esc["\""] = "\\\""
      esc["\\"] = "\\\\"
      esc["\b"] = "\\b"
      esc["\f"] = "\\f"
      esc["\n"] = "\\n"
      esc["\r"] = "\\r"
      esc["\t"] = "\\t"
      for (i = 1; i < 32; i++) {
        c = sprintf("%c", i)
        if (!(c in esc)) {
          esc[c] = sprintf("\\u%04x", i)
        }
      }
    }

    function json_escape(s,    i, n, ch, out) {
      out = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (ch in esc) {
          out = out esc[ch]
        } else {
          out = out ch
        }
      }
      return out
    }

    function json_str_or_null(has_val, s) {
      if (!has_val) return "null"
      return "\"" json_escape(s) "\""
    }

    function json_bool(b) {
      return b ? "true" : "false"
    }

    function json_error(msg) {
      exited = 1
      printf "{\"error\":\"%s\"}\n", json_escape(msg)
      exit 2
    }

    function finish_ok() {
      exited = 1
      exit 0
    }

    function is_space(ch) {
      return (ch == " " || ch == "\t" || ch == "\r" || ch == "\n")
    }

    function trim(s) {
      sub(/^[ \t\r\n]+/, "", s)
      sub(/[ \t\r\n]+$/, "", s)
      return s
    }

    function strip_comma(s) {
      if (length(s) > 1 && substr(s, length(s), 1) == ",") {
        return substr(s, 1, length(s) - 1)
      }
      return s
    }

    function unit_short(u,    lu) {
      lu = tolower(u)
      if (lu == "s" || lu == "sec" || lu == "secs" || lu == "second" || lu == "seconds") return "s"
      if (lu == "m" || lu == "min" || lu == "mins" || lu == "minute" || lu == "minutes") return "m"
      if (lu == "h" || lu == "hr" || lu == "hrs" || lu == "hour" || lu == "hours") return "h"
      if (lu == "d" || lu == "day" || lu == "days") return "d"
      return ""
    }

    function unit_mult(su) {
      if (su == "s") return 1
      if (su == "m") return 60
      if (su == "h") return 3600
      if (su == "d") return 86400
      return 0
    }

    function parse_compact_dur(w,    cw, i, n, ch, dpart, upart, su) {
      cw = strip_comma(w)
      n = length(cw)
      if (n < 2) return 0
      i = 1
      while (i <= n) {
        ch = substr(cw, i, 1)
        if (ch < "0" || ch > "9") break
        i++
      }
      if (i == 1 || i > n) return 0
      dpart = substr(cw, 1, i - 1)
      upart = substr(cw, i)
      su = unit_short(upart)
      if (su == "") return 0
      if (dpart ~ /^0+$/) {
        json_error("Invalid interval: " cw " (duration must be >= 1)")
      }
      PARSED_NUM = dpart + 0
      PARSED_UNIT = su
      PARSED_SEC = PARSED_NUM * unit_mult(su)
      PARSED_LABEL = PARSED_NUM su
      return 1
    }

    function parse_split_dur(nw, uw,    su) {
      if (nw !~ /^[0-9]+$/) return 0
      su = unit_short(strip_comma(uw))
      if (su == "") return 0
      if (nw ~ /^0+$/) {
        json_error("Invalid interval: " nw " " strip_comma(uw) " (duration must be >= 1)")
      }
      PARSED_NUM = nw + 0
      PARSED_UNIT = su
      PARSED_SEC = PARSED_NUM * unit_mult(su)
      PARSED_LABEL = PARSED_NUM su
      return 1
    }

    function tokenize_single(s,    len, pos, ch, j, nx, unq, matched) {
      len = length(s)
      pos = 1
      ntok = 0
      while (pos <= len) {
        ch = substr(s, pos, 1)
        if (is_space(ch)) {
          pos++
          continue
        }
        matched = 0
        if (ch == "\"" || ch == "\047") {
          unq = ""
          j = pos + 1
          while (j <= len) {
            if (ch == "\"" && substr(s, j, 1) == "\\" && j < len) {
              nx = substr(s, j + 1, 1)
              if (nx == "\"" || nx == "\\" || nx == "$" || nx == "`") {
                unq = unq nx
                j += 2
                continue
              }
            }
            if (substr(s, j, 1) == ch) {
              if (j == len || is_space(substr(s, j + 1, 1))) {
                ntok++
                tok[ntok] = unq
                raw_tok[ntok] = substr(s, pos, j - pos + 1)
                qflag[ntok] = 1
                pos = j + 1
                matched = 1
              }
              break
            }
            unq = unq substr(s, j, 1)
            j++
          }
          if (matched) continue
        }
        j = pos
        while (j <= len && !is_space(substr(s, j, 1))) {
          j++
        }
        ntok++
        tok[ntok] = substr(s, pos, j - pos)
        raw_tok[ntok] = tok[ntok]
        qflag[ntok] = 0
        pos = j
      }
    }

    function strip_opt_quotes(v,    n, f, l) {
      n = length(v)
      if (n >= 2) {
        f = substr(v, 1, 1)
        l = substr(v, n, 1)
        if ((f == "\"" && l == "\"") || (f == "\047" && l == "\047")) {
          return substr(v, 2, n - 2)
        }
      }
      return v
    }

    function execute_parse(is_single_mode,    i, w1, tgt, max_set, max_val, once, state_mode, stateful_flag, fresh_flag, workspace, worktree_flag, share_flag, model_set, model_val, self_flag, cron_flag, exact_timing, is_daemon, end_of_opts, rcount, t, val, has_interval, p_start, p_end, su, pcount, prompt, pacing, max_iterations, task_source, delegate, has_cron, cron_expr, use_cron) {
      if (ntok >= 1 && qflag[1] == 0 && (tok[1] == "/loop" || tok[1] == "/agy-loop:loop")) {
        for (i = 1; i < ntok; i++) {
          tok[i] = tok[i + 1]
          raw_tok[i] = raw_tok[i + 1]
          qflag[i] = qflag[i + 1]
        }
        ntok--
      }

      if (ntok == 1 && qflag[1] == 0) {
        w1 = tolower(tok[1])
        if (w1 == "status" || w1 == "list") {
          print "{\"action\":\"status\"}"
          finish_ok()
        }
        if (w1 == "doctor") {
          print "{\"action\":\"doctor\"}"
          finish_ok()
        }
        if (w1 == "help" || w1 == "--help" || w1 == "-h") {
          print "{\"action\":\"help\"}"
          finish_ok()
        }
        if (w1 == "stop" || w1 == "cancel") {
          print "{\"action\":\"stop\",\"target\":\"all\"}"
          finish_ok()
        }
      } else if (ntok == 2 && qflag[1] == 0) {
        w1 = tolower(tok[1])
        if (w1 == "stop" || w1 == "cancel") {
          tgt = trim(tok[2])
          if (tgt == "" || tolower(tgt) == "all" || tolower(tgt) == "--all" || tolower(tgt) == "-a") {
            tgt = "all"
          }
          printf "{\"action\":\"stop\",\"target\":\"%s\"}\n", json_escape(tgt)
          finish_ok()
        }
      }

      max_set = 0
      max_val = 20
      once = 0
      state_mode = "fresh"
      stateful_flag = 0
      fresh_flag = 0
      workspace = "inherit"
      worktree_flag = 0
      share_flag = 0
      model_set = 0
      model_val = ""
      self_flag = 0
      cron_flag = 0
      exact_timing = 0
      is_daemon = 0
      end_of_opts = 0
      rcount = 0

      for (i = 1; i <= ntok; i++) {
        if (!end_of_opts && qflag[i] == 0) {
          t = tok[i]
          if (t == "--") {
            end_of_opts = 1
            continue
          }
          if (t == "--once") {
            once = 1
            continue
          }
          if (t == "--stateful") {
            if (fresh_flag) {
              json_error("Conflicting flags: --stateful and --fresh cannot be combined")
            }
            stateful_flag = 1
            state_mode = "stateful"
            continue
          }
          if (t == "--fresh") {
            if (stateful_flag) {
              json_error("Conflicting flags: --stateful and --fresh cannot be combined")
            }
            fresh_flag = 1
            state_mode = "fresh"
            continue
          }
          if (t == "--worktree") {
            if (share_flag) {
              json_error("Conflicting flags: --worktree and --share cannot be combined")
            }
            worktree_flag = 1
            workspace = "branch"
            continue
          }
          if (t == "--share") {
            if (worktree_flag) {
              json_error("Conflicting flags: --worktree and --share cannot be combined")
            }
            share_flag = 1
            workspace = "share"
            continue
          }
          if (t == "--self") {
            self_flag = 1
            continue
          }
          if (t == "--cron") {
            cron_flag = 1
            continue
          }
          if (t == "--exact") {
            exact_timing = 1
            continue
          }
          if (t == "--daemon") {
            is_daemon = 1
            continue
          }
          if (t == "--max") {
            if (i + 1 > ntok) {
              json_error("Missing value for --max")
            }
            i++
            val = strip_opt_quotes(tok[i])
            if (val !~ /^[1-9][0-9]*$/) {
              json_error("Invalid --max value: " val " (expected positive integer)")
            }
            max_set = 1
            max_val = val + 0
            continue
          }
          if (index(t, "--max=") == 1) {
            val = strip_opt_quotes(substr(t, 7))
            if (val !~ /^[1-9][0-9]*$/) {
              json_error("Invalid --max value: " val " (expected positive integer)")
            }
            max_set = 1
            max_val = val + 0
            continue
          }
          if (t == "--model") {
            if (i + 1 > ntok) {
              json_error("Missing value for --model")
            }
            i++
            val = strip_opt_quotes(tok[i])
            if (val != "inherit" && val != "flash_lite" && val != "flash" && val != "pro") {
              json_error("Invalid --model tier: " val " (expected inherit, flash_lite, flash, or pro)")
            }
            model_set = 1
            model_val = val
            continue
          }
          if (index(t, "--model=") == 1) {
            val = strip_opt_quotes(substr(t, 9))
            if (val != "inherit" && val != "flash_lite" && val != "flash" && val != "pro") {
              json_error("Invalid --model tier: " val " (expected inherit, flash_lite, flash, or pro)")
            }
            model_set = 1
            model_val = val
            continue
          }
        }
        rcount++
        rtok[rcount] = tok[i]
        rraw[rcount] = raw_tok[i]
        rq[rcount] = qflag[i]
      }

      has_interval = 0
      p_start = 1
      p_end = rcount

      if (rcount >= 2 && rq[1] == 0 && tolower(rtok[1]) == "in") {
        if (rq[2] == 0 && parse_compact_dur(rtok[2])) {
          once = 1
          has_interval = 1
          p_start = 3
        } else if (rcount >= 3 && rq[2] == 0 && rq[3] == 0 && parse_split_dur(rtok[2], rtok[3])) {
          once = 1
          has_interval = 1
          p_start = 4
        } else if (rcount >= 3 && rq[2] == 0 && (tolower(rtok[2]) == "a" || tolower(rtok[2]) == "an") && rq[3] == 0 && unit_short(strip_comma(rtok[3])) != "") {
          su = unit_short(strip_comma(rtok[3]))
          PARSED_NUM = 1
          PARSED_UNIT = su
          PARSED_SEC = unit_mult(su)
          PARSED_LABEL = "1" su
          once = 1
          has_interval = 1
          p_start = 4
        }
      } else if (rcount >= 1 && rq[1] == 0) {
        if (parse_compact_dur(rtok[1])) {
          has_interval = 1
          p_start = 2
        } else if (rcount >= 2 && rq[2] == 0 && parse_split_dur(rtok[1], rtok[2])) {
          has_interval = 1
          p_start = 3
        }
      }

      if (!has_interval) {
        if (rcount >= 3 && rq[rcount - 2] == 0 && tolower(rtok[rcount - 2]) == "every" && rq[rcount - 1] == 0 && rq[rcount] == 0 && parse_split_dur(rtok[rcount - 1], rtok[rcount])) {
          has_interval = 1
          p_end = rcount - 3
        } else if (rcount >= 2 && rq[rcount - 1] == 0 && tolower(rtok[rcount - 1]) == "every" && rq[rcount] == 0) {
          if (parse_compact_dur(rtok[rcount])) {
            has_interval = 1
            p_end = rcount - 2
          } else if (unit_short(strip_comma(rtok[rcount])) != "") {
            su = unit_short(strip_comma(rtok[rcount]))
            PARSED_NUM = 1
            PARSED_UNIT = su
            PARSED_SEC = unit_mult(su)
            PARSED_LABEL = "1" su
            has_interval = 1
            p_end = rcount - 2
          }
        }
        if (has_interval && p_end >= p_start && rq[p_end] == 0) {
          rraw[p_end] = strip_comma(rraw[p_end])
          rtok[p_end] = strip_comma(rtok[p_end])
        }
      }

      if (once && cron_flag) {
        json_error("Conflicting flags: one-shot mode (--once or in <delay>) cannot be combined with --cron")
      }
      if (once && max_set && max_val > 1) {
        json_error("Conflicting flags: one-shot mode (--once or in <delay>) cannot use --max > 1")
      }

      pcount = (p_end >= p_start) ? (p_end - p_start + 1) : 0
      if (pcount == 0) {
        prompt = ""
      } else if (pcount == 1 && rq[p_start] == 1) {
        prompt = rtok[p_start]
      } else {
        prompt = ""
        for (i = p_start; i <= p_end; i++) {
          if (i > p_start) prompt = prompt " "
          prompt = prompt rraw[i]
        }
      }
      prompt = trim(prompt)

      pacing = has_interval ? "fixed" : "dynamic"
      max_iterations = max_set ? max_val : (once ? 1 : 20)
      task_source = (prompt != "") ? "inline" : "loop_md_or_default"
      delegate = (self_flag || substr(prompt, 1, 1) == "/") ? "self" : "loop-worker"

      has_cron = 0
      cron_expr = ""
      if (has_interval && PARSED_SEC >= 60) {
        if (PARSED_SEC == 60) {
          has_cron = 1
          cron_expr = "* * * * *"
        } else if (PARSED_SEC < 3600 && (PARSED_SEC % 60) == 0 && (60 % (PARSED_SEC / 60)) == 0) {
          has_cron = 1
          cron_expr = "*/" (PARSED_SEC / 60) " * * * *"
        } else if (PARSED_SEC == 3600) {
          has_cron = 1
          cron_expr = "0 * * * *"
        } else if (PARSED_SEC < 86400 && (PARSED_SEC % 3600) == 0 && (24 % (PARSED_SEC / 3600)) == 0) {
          has_cron = 1
          cron_expr = "0 */" (PARSED_SEC / 3600) " * * *"
        } else if (PARSED_SEC == 86400) {
          has_cron = 1
          cron_expr = "0 0 * * *"
        }
      }

      use_cron = (cron_flag && has_cron && !once) ? 1 : 0

      printf "{"
      printf "\"action\":\"run\","
      printf "\"pacing\":\"%s\",", pacing
      printf "\"once\":%s,", json_bool(once)
      if (has_interval) {
        printf "\"interval_sec\":%d,", PARSED_SEC
        printf "\"interval_label\":\"%s\",", json_escape(PARSED_LABEL)
      } else {
        printf "\"interval_sec\":null,"
        printf "\"interval_label\":null,"
      }
      printf "\"cron_expr\":%s,", json_str_or_null(has_cron, cron_expr)
      printf "\"use_cron\":%s,", json_bool(use_cron)
      printf "\"exact_timing\":%s,", json_bool(exact_timing)
      printf "\"is_daemon\":%s,", json_bool(is_daemon)
      printf "\"max_iterations\":%d,", max_iterations
      printf "\"state_mode\":\"%s\",", state_mode
      printf "\"workspace\":\"%s\",", workspace
      printf "\"model\":%s,", json_str_or_null(model_set, model_val)
      printf "\"delegate\":\"%s\",", delegate
      printf "\"task_source\":\"%s\",", task_source
      printf "\"prompt\":\"%s\"", json_escape(prompt)
      printf "}\n"
      finish_ok()
    }

    BEGIN {
      init_tables()
      exited = 0
      use_stdin = (ENVIRON["LP_STDIN"] == "1") ? 1 : 0
      if (!use_stdin) {
        raw_argc = ARGC - 2
        ntok = 0
        if (raw_argc == 1) {
          tokenize_single(ARGV[2])
          execute_parse(1)
        } else {
          for (i = 1; i <= raw_argc; i++) {
            ntok++
            tok[ntok] = ARGV[i + 1]
            raw_tok[ntok] = ARGV[i + 1]
            qflag[ntok] = 0
          }
          execute_parse(0)
        }
      } else {
        ARGC = 1
        stdin_buf = ""
      }
    }

    {
      if (use_stdin) {
        stdin_buf = (NR == 1) ? $0 : (stdin_buf "\n" $0)
      }
    }

    END {
      if (!exited && use_stdin) {
        ntok = 0
        tokenize_single(stdin_buf)
        execute_parse(1)
      }
    }
  ' SENTINEL "$@"
}

run_resolve_task() {
  ws_dir="$(normalize_dir "${1:-$PWD}")"
  home_dir="${HOME:-}"

  sel_source="builtin"
  sel_path=""

  if [ -f "$ws_dir/.agents/loop.md" ] && [ -s "$ws_dir/.agents/loop.md" ]; then
    sel_source=".agents/loop.md"
    sel_path="$ws_dir/.agents/loop.md"
  elif [ -f "$ws_dir/loop.md" ] && [ -s "$ws_dir/loop.md" ]; then
    sel_source="loop.md"
    sel_path="$ws_dir/loop.md"
  elif [ -n "$home_dir" ] && [ -f "$home_dir/.gemini/config/loop.md" ] && [ -s "$home_dir/.gemini/config/loop.md" ]; then
    sel_source="~/.gemini/config/loop.md"
    sel_path="$home_dir/.gemini/config/loop.md"
  fi

  if [ "$sel_source" = "builtin" ]; then
    POSIXLY_CORRECT=1 LC_ALL=C awk '
      BEGIN {
        p = "Execute one non-blocking branch maintenance pass: (1) check git status and run fast incremental tests or build checks for any modified/unfinished work; (2) if gh CLI is available and an open PR exists for the current branch, inspect PR check runs and unresolved review comments, applying minimal verified fixes if straightforward; (3) if everything is clean and green, report in one concise line and recommend an idle backoff."
        printf "{\"source\":\"builtin\",\"path\":null,\"truncated\":false,\"prompt\":\"%s\"}\n", p
        exit 0
      }
    '
    return 0
  fi

  byte_len="$(wc -c < "$sel_path" | tr -d '[:space:]')"
  LP_SOURCE="$sel_source" LP_PATH="$sel_path" LP_BYTES="$byte_len" \
  POSIXLY_CORRECT=1 LC_ALL=C awk '
    function init_tables(    i, c) {
      for (i = 1; i < 256; i++) {
        ord[sprintf("%c", i)] = i
      }
      esc["\""] = "\\\""
      esc["\\"] = "\\\\"
      esc["\b"] = "\\b"
      esc["\f"] = "\\f"
      esc["\n"] = "\\n"
      esc["\r"] = "\\r"
      esc["\t"] = "\\t"
      for (i = 1; i < 32; i++) {
        c = sprintf("%c", i)
        if (!(c in esc)) {
          esc[c] = sprintf("\\u%04x", i)
        }
      }
    }

    function json_escape(s,    i, n, ch, out) {
      out = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (ch in esc) {
          out = out esc[ch]
        } else {
          out = out ch
        }
      }
      return out
    }

    function utf8_safe_cap(s, cap,    n, cont, lead_pos, lb, seq_len) {
      n = length(s)
      if (n <= cap) return s
      s = substr(s, 1, cap)
      if (ord[substr(s, cap, 1)] < 128) return s
      cont = 0
      while (cont < 3 && (cap - cont) >= 1) {
        lb = ord[substr(s, cap - cont, 1)]
        if (lb >= 128 && lb < 192) {
          cont++
        } else {
          break
        }
      }
      lead_pos = cap - cont
      if (lead_pos < 1) return ""
      lb = ord[substr(s, lead_pos, 1)]
      if (lb >= 240) seq_len = 4
      else if (lb >= 224) seq_len = 3
      else if (lb >= 192) seq_len = 2
      else seq_len = 99
      if ((cont + 1) < seq_len) {
        return substr(s, 1, lead_pos - 1)
      }
      return s
    }

    BEGIN {
      init_tables()
      src = ENVIRON["LP_SOURCE"]
      fpath = ENVIRON["LP_PATH"]
      total_bytes = ENVIRON["LP_BYTES"] + 0
      cap = 25000
      buf = ""
      sum_lines = 0
    }

    {
      if (NR > 1) {
        if (length(buf) < cap + 8) buf = buf "\n"
      }
      sum_lines += length($0)
      if (length(buf) < cap + 8) {
        buf = buf $0
      }
    }

    END {
      if (NR > 0 && (sum_lines + NR) == total_bytes) {
        if (length(buf) < cap + 8) buf = buf "\n"
      }
      truncated = (total_bytes > cap) ? 1 : 0
      if (truncated) {
        buf = utf8_safe_cap(buf, cap)
      }
      printf "{\"source\":\"%s\",\"path\":\"%s\",\"truncated\":%s,\"prompt\":\"%s\"}\n",
        json_escape(src),
        json_escape(fpath),
        (truncated ? "true" : "false"),
        json_escape(buf)
    }
  ' "$sel_path"
}

inspect_skills_json() {
  _sj="$1"
  if [ ! -f "$_sj" ]; then
    return 0
  fi
  LP_SJ_PATH="$_sj" POSIXLY_CORRECT=1 LC_ALL=C awk '
    function pattern_matches_loop(pat) {
      if (pat == "loop" || pat == "agy-loop" || pat == "agy-loop:loop" || pat == "*" || pat == ".*") {
        return 1
      }
      if (pat == "loop.*" || pat == ".*loop.*" || pat == "agy-loop:.*") {
        return 1
      }
      return 0
    }

    {
      raw = (NR == 1) ? $0 : (raw "\n" $0)
    }

    END {
      sj = ENVIRON["LP_SJ_PATH"]
      n = length(raw)
      i = 1
      ntk = 0
      unclosed_str = 0

      while (i <= n) {
        ch = substr(raw, i, 1)
        if (ch == " " || ch == "\t" || ch == "\r" || ch == "\n") {
          i++
          continue
        }
        if (ch == "/" && i < n && substr(raw, i + 1, 1) == "/") {
          i += 2
          while (i <= n && substr(raw, i, 1) != "\n") i++
          continue
        }
        if (ch == "/" && i < n && substr(raw, i + 1, 1) == "*") {
          i += 2
          while (i <= n && !(substr(raw, i, 1) == "*" && i < n && substr(raw, i + 1, 1) == "/")) i++
          if (i <= n) i += 2
          continue
        }
        if (ch == "\"") {
          sval = ""
          i++
          closed = 0
          while (i <= n) {
            sc = substr(raw, i, 1)
            if (sc == "\\" && i < n) {
              nx = substr(raw, i + 1, 1)
              if (nx == "n") sval = sval "\n"
              else if (nx == "r") sval = sval "\r"
              else if (nx == "t") sval = sval "\t"
              else sval = sval nx
              i += 2
              continue
            }
            if (sc == "\"") {
              closed = 1
              i++
              break
            }
            sval = sval sc
            i++
          }
          if (!closed) unclosed_str = 1
          ntk++
          tk_type[ntk] = "STR"
          tk_val[ntk] = sval
          continue
        }
        if (ch == ":" || ch == "[" || ch == "]" || ch == "{" || ch == "}" || ch == ",") {
          ntk++
          tk_type[ntk] = "SYM"
          tk_val[ntk] = ch
          i++
          continue
        }
        j = i
        while (j <= n) {
          c2 = substr(raw, j, 1)
          if (c2 == " " || c2 == "\t" || c2 == "\r" || c2 == "\n" || c2 == "\"" || c2 == ":" || c2 == "[" || c2 == "]" || c2 == "{" || c2 == "}" || c2 == "," || c2 == "/") {
            break
          }
          j++
        }
        ntk++
        tk_type[ntk] = "LIT"
        tk_val[ntk] = substr(raw, i, j - i)
        i = j
      }

      if (unclosed_str) {
        printf "%s: invalid JSON/JSONC (unterminated string)\n", sj
        exit 0
      }

      has_inc_warn = 0
      has_exc_warn = 0

      for (k = 1; k <= ntk - 2; k++) {
        if (tk_type[k] == "STR" && (tk_val[k] == "include_only" || tk_val[k] == "exclude")) {
          if (k > 1 && !(tk_type[k - 1] == "SYM" && (tk_val[k - 1] == "{" || tk_val[k - 1] == ","))) {
            continue
          }
          if (tk_type[k + 1] == "SYM" && tk_val[k + 1] == ":" && tk_type[k + 2] == "SYM" && tk_val[k + 2] == "[") {
            key = tk_val[k]
            depth = 1
            matched_loop = 0
            m = k + 3
            while (m <= ntk && depth > 0) {
              if (tk_type[m] == "SYM" && tk_val[m] == "[") {
                depth++
              } else if (tk_type[m] == "SYM" && tk_val[m] == "]") {
                depth--
              } else if (depth == 1 && tk_type[m] == "STR") {
                if (pattern_matches_loop(tk_val[m])) {
                  matched_loop = 1
                }
              }
              m++
            }
            if (key == "include_only" && !matched_loop) {
              has_inc_warn = 1
            }
            if (key == "exclude" && matched_loop) {
              has_exc_warn = 1
            }
          }
        }
      }

      if (has_inc_warn) {
        printf "%s: include_only omits \"loop\"\n", sj
      }
      if (has_exc_warn) {
        printf "%s: exclude blocks \"loop\"\n", sj
      }
    }
  ' "$_sj"
}

run_doctor() {
  ws_dir="$(normalize_dir "${1:-$PWD}")"
  home_dir="${HOME:-}"

  s1=""
  s2=""
  s3=""
  s4=""
  if [ -n "$home_dir" ]; then
    p1="$home_dir/.gemini/config/skills/loop"
    p2="$home_dir/.gemini/config/agents/loop-worker.md"
    p3="$home_dir/.gemini/antigravity-cli/skills/loop"
    p4="$home_dir/.gemini/skills/loop"
    if [ -e "$p1" ] || [ -L "$p1" ]; then s1="$p1"; fi
    if [ -e "$p2" ] || [ -L "$p2" ]; then s2="$p2"; fi
    if [ -e "$p3" ] || [ -L "$p3" ]; then s3="$p3"; fi
    if [ -e "$p4" ] || [ -L "$p4" ]; then s4="$p4"; fi
  fi

  ws_warns="$(inspect_skills_json "$ws_dir/.agents/skills.json")"
  gl_warns=""
  if [ -n "$home_dir" ]; then
    gl_warns="$(inspect_skills_json "$home_dir/.gemini/config/skills.json")"
  fi

  active_md=""
  if [ -f "$ws_dir/.agents/loop.md" ] && [ -s "$ws_dir/.agents/loop.md" ]; then
    active_md="$ws_dir/.agents/loop.md"
  elif [ -f "$ws_dir/loop.md" ] && [ -s "$ws_dir/loop.md" ]; then
    active_md="$ws_dir/loop.md"
  elif [ -n "$home_dir" ] && [ -f "$home_dir/.gemini/config/loop.md" ] && [ -s "$home_dir/.gemini/config/loop.md" ]; then
    active_md="$home_dir/.gemini/config/loop.md"
  fi

  LP_S1="$s1" LP_S2="$s2" LP_S3="$s3" LP_S4="$s4" \
  LP_WS_WARNS="$ws_warns" LP_GL_WARNS="$gl_warns" LP_ACTIVE="$active_md" \
  POSIXLY_CORRECT=1 LC_ALL=C awk '
    function init_tables(    i, c) {
      esc["\""] = "\\\""
      esc["\\"] = "\\\\"
      esc["\b"] = "\\b"
      esc["\f"] = "\\f"
      esc["\n"] = "\\n"
      esc["\r"] = "\\r"
      esc["\t"] = "\\t"
      for (i = 1; i < 32; i++) {
        c = sprintf("%c", i)
        if (!(c in esc)) {
          esc[c] = sprintf("\\u%04x", i)
        }
      }
    }

    function json_escape(s,    i, n, ch, out) {
      out = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (ch in esc) {
          out = out esc[ch]
        } else {
          out = out ch
        }
      }
      return out
    }

    function add_lines(blob,    n, idx, arr) {
      if (blob == "") return
      n = split(blob, arr, "\n")
      for (idx = 1; idx <= n; idx++) {
        if (arr[idx] != "") {
          warns[++wc] = arr[idx]
        }
      }
    }

    BEGIN {
      init_tables()
      sc = 0
      if (ENVIRON["LP_S1"] != "") shadows[++sc] = ENVIRON["LP_S1"]
      if (ENVIRON["LP_S2"] != "") shadows[++sc] = ENVIRON["LP_S2"]
      if (ENVIRON["LP_S3"] != "") shadows[++sc] = ENVIRON["LP_S3"]
      if (ENVIRON["LP_S4"] != "") shadows[++sc] = ENVIRON["LP_S4"]

      wc = 0
      add_lines(ENVIRON["LP_WS_WARNS"])
      add_lines(ENVIRON["LP_GL_WARNS"])

      ok = (sc == 0 && wc == 0) ? "true" : "false"
      act = ENVIRON["LP_ACTIVE"]

      printf "{\"ok\":%s,\"shadows\":[", ok
      for (i = 1; i <= sc; i++) {
        if (i > 1) printf ","
        printf "\"%s\"", json_escape(shadows[i])
      }
      printf "],\"skill_filter_warnings\":["
      for (i = 1; i <= wc; i++) {
        if (i > 1) printf ","
        printf "\"%s\"", json_escape(warns[i])
      }
      printf "],\"active_loop_md\":"
      if (act != "") {
        printf "\"%s\"", json_escape(act)
      } else {
        printf "null"
      }
      printf "}\n"
      exit 0
    }
  '
}

case "$SUBCMD" in
  parse)
    run_parse "$@"
    ;;
  resolve-task)
    run_resolve_task "$@"
    ;;
  doctor)
    run_doctor "$@"
    ;;
  help|--help|-h|"")
    printf '%s\n' '{"usage":"loop-helper.sh <parse|resolve-task|doctor> [args...]"}'
    exit 0
    ;;
  *)
    POSIXLY_CORRECT=1 LC_ALL=C awk '
      function init_tables(    i, c) {
        esc["\""] = "\\\""
        esc["\\"] = "\\\\"
        esc["\b"] = "\\b"
        esc["\f"] = "\\f"
        esc["\n"] = "\\n"
        esc["\r"] = "\\r"
        esc["\t"] = "\\t"
        for (i = 1; i < 32; i++) {
          c = sprintf("%c", i)
          if (!(c in esc)) {
            esc[c] = sprintf("\\u%04x", i)
          }
        }
      }
      function json_escape(s,    i, n, ch, out) {
        out = ""
        n = length(s)
        for (i = 1; i <= n; i++) {
          ch = substr(s, i, 1)
          if (ch in esc) out = out esc[ch]
          else out = out ch
        }
        return out
      }
      BEGIN {
        init_tables()
        printf "{\"error\":\"Unknown subcommand: %s\"}\n", json_escape(ARGV[2])
        exit 2
      }
    ' SENTINEL "$SUBCMD"
    ;;
esac
