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

    function is_fractional_compact(w,    cw, i, n, ch, upart) {
      cw = strip_comma(w)
      if (cw !~ /^[0-9]*\.[0-9]+[A-Za-z]+$/) return 0
      n = length(cw)
      i = 1
      while (i <= n) {
        ch = substr(cw, i, 1)
        if ((ch >= "0" && ch <= "9") || ch == ".") {
          i++
        } else {
          break
        }
      }
      if (i > n) return 0
      upart = substr(cw, i)
      return (unit_short(upart) != "") ? 1 : 0
    }

    function check_fractional_compact(w) {
      if (is_fractional_compact(w)) {
        json_error("Invalid interval: " strip_comma(w) " (fractional durations are not supported; use integer units like 90s or 1m30s)")
      }
    }

    function check_fractional_split(nw, uw) {
      if (nw ~ /^[0-9]*\.[0-9]+$/ && unit_short(strip_comma(uw)) != "") {
        json_error("Invalid interval: " nw " " strip_comma(uw) " (fractional durations are not supported; use integer units like 90s or 1m30s)")
      }
    }

    function looks_like_compact_dur(w,    cw, pos, n, ch, dstart, ustart, upart, su, segs) {
      cw = strip_comma(w)
      n = length(cw)
      if (n < 2) return 0
      ch = substr(cw, 1, 1)
      if (ch < "0" || ch > "9") return 0
      pos = 1
      segs = 0
      while (pos <= n) {
        dstart = pos
        while (pos <= n) {
          ch = substr(cw, pos, 1)
          if (ch < "0" || ch > "9") break
          pos++
        }
        if (pos == dstart || pos > n) return 0
        ustart = pos
        while (pos <= n) {
          ch = substr(cw, pos, 1)
          if (!((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"))) break
          pos++
        }
        if (pos == ustart) return 0
        upart = substr(cw, ustart, pos - ustart)
        su = unit_short(upart)
        if (su == "") return 0
        segs++
      }
      return (segs > 0) ? 1 : 0
    }

    function parse_compact_dur(w,    cw, pos, n, ch, dstart, ustart, dpart, upart, su, seg_num, total_sec, label, seen_s, seen_m, seen_h, seen_d, segs, last_su) {
      if (!looks_like_compact_dur(w)) return 0
      cw = strip_comma(w)
      n = length(cw)
      pos = 1
      total_sec = 0
      label = ""
      segs = 0
      last_su = ""
      seen_s = 0; seen_m = 0; seen_h = 0; seen_d = 0

      while (pos <= n) {
        dstart = pos
        while (pos <= n) {
          ch = substr(cw, pos, 1)
          if (ch < "0" || ch > "9") break
          pos++
        }
        dpart = substr(cw, dstart, pos - dstart)
        ustart = pos
        while (pos <= n) {
          ch = substr(cw, pos, 1)
          if (!((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"))) break
          pos++
        }
        upart = substr(cw, ustart, pos - ustart)
        su = unit_short(upart)

        if ((su == "s" && seen_s) || (su == "m" && seen_m) || (su == "h" && seen_h) || (su == "d" && seen_d)) {
          json_error("Invalid interval: " cw " (duplicate unit \047" su "\047)")
        }
        if (su == "s") seen_s = 1
        else if (su == "m") seen_m = 1
        else if (su == "h") seen_h = 1
        else if (su == "d") seen_d = 1

        if (dpart ~ /^0+$/) {
          json_error("Invalid interval: " cw " (duration must be >= 1)")
        }

        seg_num = dpart + 0
        total_sec += seg_num * unit_mult(su)
        label = label seg_num su
        last_su = su
        segs++
      }

      PARSED_NUM = total_sec
      PARSED_UNIT = (segs == 1) ? last_su : "compound"
      PARSED_SEC = total_sec
      PARSED_LABEL = label
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

    function edit_distance(a, b,    la, lb, i, j, ca, cb, pa, pb, cost, v1, v2, v3, d) {
      la = length(a)
      lb = length(b)
      if (la == 0) return lb
      if (lb == 0) return la
      for (i = 0; i <= la; i++) d[i, 0] = i
      for (j = 0; j <= lb; j++) d[0, j] = j
      for (i = 1; i <= la; i++) {
        ca = substr(a, i, 1)
        pa = (i > 1) ? substr(a, i - 1, 1) : ""
        for (j = 1; j <= lb; j++) {
          cb = substr(b, j, 1)
          pb = (j > 1) ? substr(b, j - 1, 1) : ""
          cost = (ca == cb) ? 0 : 1
          v1 = d[i - 1, j] + 1
          v2 = d[i, j - 1] + 1
          v3 = d[i - 1, j - 1] + cost
          d[i, j] = (v1 < v2) ? v1 : v2
          if (v3 < d[i, j]) d[i, j] = v3
          if (i > 1 && j > 1 && ca == pb && pa == cb) {
            if (d[i - 2, j - 2] + cost < d[i, j]) {
              d[i, j] = d[i - 2, j - 2] + cost
            }
          }
        }
      }
      return d[la, lb]
    }

    function is_interval_prefix_token(idx,    lt) {
      if (rq[idx] != 0) return 0
      lt = tolower(strip_comma(rtok[idx]))
      if (lt == "in" || lt == "every" || lt == "a" || lt == "an") return 1
      if (rtok[idx] ~ /^[0-9]+$/) return 1
      if (unit_short(lt) != "") return 1
      if (looks_like_compact_dur(rtok[idx])) return 1
      if (is_fractional_compact(rtok[idx])) return 1
      if (rtok[idx] ~ /^[0-9]*\.[0-9]+$/) return 1
      return 0
    }

    function is_leading_interval_pos(rc,    j) {
      if (rc == 0) return 1
      for (j = 1; j <= rc; j++) {
        if (!is_interval_prefix_token(j)) return 0
      }
      return 1
    }

    function init_flag_hints() {
      kflags[1] = "once"
      kflags[2] = "stateful"
      kflags[3] = "fresh"
      kflags[4] = "worktree"
      kflags[5] = "share"
      kflags[6] = "self"
      kflags[7] = "cron"
      kflags[8] = "exact"
      kflags[9] = "daemon"
      kflags[10] = "max"
      kflags[11] = "model"

      flag_aliases["--statefull"] = "--stateful"
      flag_aliases["--stateless"] = "--fresh"
      flag_aliases["--state-full"] = "--stateful"
      flag_aliases["--work-tree"] = "--worktree"
      flag_aliases["--worktrees"] = "--worktree"
      flag_aliases["--work_tree"] = "--worktree"
      flag_aliases["--max-iter"] = "--max"
      flag_aliases["--max-iters"] = "--max"
      flag_aliases["--max-iteration"] = "--max"
      flag_aliases["--max-iterations"] = "--max"
      flag_aliases["--max-runs"] = "--max"
      flag_aliases["--models"] = "--model"
      flag_aliases["--crons"] = "--cron"
      flag_aliases["--daemons"] = "--daemon"
      flag_aliases["--exacts"] = "--exact"
      flag_aliases["--onces"] = "--once"
      flag_aliases["--selfs"] = "--self"
      flag_aliases["--shares"] = "--share"
      flag_aliases["--freshes"] = "--fresh"
      flag_aliases["--freshs"] = "--fresh"
    }

    function handle_unknown_option(t, rc,    eqp, fname, lfname, stem, k, max_d, d, best_d, best_k) {
      eqp = index(t, "=")
      fname = (eqp > 0) ? substr(t, 1, eqp - 1) : t
      lfname = tolower(fname)
      if (lfname in flag_aliases) {
        json_error("Unknown option: " t " (did you mean " flag_aliases[lfname] "? Put \047--\047 before prompt text if literal)")
      }
      stem = substr(lfname, 3)
      best_k = ""
      best_d = 999
      if (length(stem) >= 2) {
        for (k = 1; k <= 11; k++) {
          max_d = (length(kflags[k]) <= 4) ? 1 : 2
          d = edit_distance(stem, kflags[k])
          if (d <= max_d && (best_k == "" || d < best_d)) {
            best_d = d
            best_k = kflags[k]
          }
        }
      }
      if (best_k != "") {
        json_error("Unknown option: " t " (did you mean --" best_k "? Put \047--\047 before prompt text if literal)")
      }
      if (is_leading_interval_pos(rc)) {
        json_error("Unknown option: " t " (put \047--\047 before prompt text if literal)")
      }
      warnings[++wcount] = "Kept unrecognized flag \047" t "\047 as literal prompt text (use \047--\047 before prompt if intentional)."
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

    function execute_parse(is_single_mode,    i, w1, st_all, st_json, after_current, has_all, st_ntgt, ti, lti, tgt, max_set, max_val, once, state_mode, stateful_flag, fresh_flag, workspace, worktree_flag, share_flag, model_set, model_val, self_flag, cron_flag, exact_timing, is_daemon, end_of_opts, rcount, t, val, has_interval, p_start, p_end, su, pcount, prompt, pacing, max_iterations, task_source, delegate, has_cron, cron_expr, use_cron) {
      if (ntok >= 1 && qflag[1] == 0 && (tok[1] == "/loop" || tok[1] == "/agy-loop:loop")) {
        for (i = 1; i < ntok; i++) {
          tok[i] = tok[i + 1]
          raw_tok[i] = raw_tok[i + 1]
          qflag[i] = qflag[i + 1]
        }
        ntok--
      }

      if (ntok >= 1 && qflag[1] == 0) {
        w1 = tolower(tok[1])
        if (w1 == "status" || w1 == "list") {
          st_all = 0
          st_json = 0
          for (i = 2; i <= ntok; i++) {
            if (qflag[i] == 0 && tok[i] == "--all") {
              st_all = 1
            } else if (qflag[i] == 0 && tok[i] == "--json") {
              st_json = 1
            } else {
              json_error("Unknown argument for " w1 ": " tok[i] " (expected /agy-loop:loop " w1 " [--all] [--json])")
            }
          }
          printf "{\"action\":\"status\""
          if (st_all) printf ",\"all\":true"
          if (st_json) printf ",\"json\":true"
          printf "}\n"
          finish_ok()
        }
        if (w1 == "doctor") {
          if (ntok == 1) {
            print "{\"action\":\"doctor\"}"
            finish_ok()
          }
          if (ntok == 2 && qflag[2] == 0 && tok[2] == "--clean-shadow") {
            print "{\"action\":\"doctor\",\"clean_shadow\":true}"
            finish_ok()
          }
          json_error("Unknown arguments for doctor (expected /loop doctor or /loop doctor --clean-shadow)")
        }
        if (w1 == "clean-shadow") {
          if (ntok == 1) {
            print "{\"action\":\"doctor\",\"clean_shadow\":true}"
            finish_ok()
          }
          json_error("Unexpected arguments for clean-shadow (expected /agy-loop:loop clean-shadow)")
        }
        if (w1 == "help" || w1 == "--help" || w1 == "-h") {
          if (ntok == 1) {
            print "{\"action\":\"help\"}"
            finish_ok()
          }
          json_error("Unexpected arguments for help (expected /agy-loop:loop help)")
        }
        if (w1 == "stop" || w1 == "cancel") {
          after_current = 0
          has_all = 0
          st_ntgt = 0
          for (i = 2; i <= ntok; i++) {
            ti = tok[i]
            lti = tolower(ti)
            if (qflag[i] == 0 && ti == "--after-current") {
              after_current = 1
            } else if (qflag[i] == 0 && (lti == "all" || lti == "--all" || lti == "-a")) {
              has_all = 1
            } else if (qflag[i] == 0 && substr(ti, 1, 1) == "-") {
              json_error("Unknown option for " w1 ": " ti)
            } else {
              tgt = trim(ti)
              if (tgt == "") {
                json_error("Invalid empty target for " w1)
              }
              if (tolower(tgt) == "all") {
                has_all = 1
              } else {
                st_tgts[++st_ntgt] = tgt
              }
            }
          }
          if (has_all && st_ntgt > 0) {
            json_error("Cannot combine \047all\047 with specific targets for " w1)
          }
          if (st_ntgt == 0) {
            printf "{\"action\":\"stop\",\"target\":\"all\""
          } else if (st_ntgt == 1) {
            printf "{\"action\":\"stop\",\"target\":\"%s\"", json_escape(st_tgts[1])
          } else {
            printf "{\"action\":\"stop\",\"target\":\"%s\",\"targets\":[", json_escape(st_tgts[1])
            for (i = 1; i <= st_ntgt; i++) {
              if (i > 1) printf ","
              printf "\"%s\"", json_escape(st_tgts[i])
            }
            printf "]"
          }
          if (after_current) printf ",\"after_current\":true"
          printf "}\n"
          finish_ok()
        }
      }
      if (ntok == 2 && qflag[1] == 0 && tok[1] == "--clean-shadow" && qflag[2] == 0 && tolower(tok[2]) == "doctor") {
        print "{\"action\":\"doctor\",\"clean_shadow\":true}"
        finish_ok()
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
      wcount = 0

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
          if (substr(t, 1, 2) == "--") {
            handle_unknown_option(t, rcount)
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
        if (rq[2] == 0) {
          check_fractional_compact(rtok[2])
        }
        if (rcount >= 3 && rq[2] == 0 && rq[3] == 0) {
          check_fractional_split(rtok[2], rtok[3])
        }
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
      } else if (rcount >= 2 && rq[1] == 0 && tolower(rtok[1]) == "every") {
        if (rq[2] == 0) {
          check_fractional_compact(rtok[2])
        }
        if (rcount >= 3 && rq[2] == 0 && rq[3] == 0) {
          check_fractional_split(rtok[2], rtok[3])
        }
        if (rq[2] == 0 && parse_compact_dur(rtok[2])) {
          has_interval = 1
          p_start = 3
        } else if (rcount >= 3 && rq[2] == 0 && rq[3] == 0 && parse_split_dur(rtok[2], rtok[3])) {
          has_interval = 1
          p_start = 4
        } else if (rq[2] == 0 && unit_short(strip_comma(rtok[2])) != "") {
          su = unit_short(strip_comma(rtok[2]))
          PARSED_NUM = 1
          PARSED_UNIT = su
          PARSED_SEC = unit_mult(su)
          PARSED_LABEL = "1" su
          has_interval = 1
          p_start = 3
        }
      } else if (rcount >= 1 && rq[1] == 0) {
        check_fractional_compact(rtok[1])
        if (rcount >= 2 && rq[2] == 0) {
          check_fractional_split(rtok[1], rtok[2])
        }
        if (parse_compact_dur(rtok[1])) {
          has_interval = 1
          p_start = 2
        } else if (rcount >= 2 && rq[2] == 0 && parse_split_dur(rtok[1], rtok[2])) {
          has_interval = 1
          p_start = 3
        }
      }

      if (!has_interval) {
        if (rcount >= 3 && rq[rcount - 2] == 0 && tolower(rtok[rcount - 2]) == "every" && rq[rcount - 1] == 0 && rq[rcount] == 0) {
          check_fractional_split(rtok[rcount - 1], rtok[rcount])
          if (parse_split_dur(rtok[rcount - 1], rtok[rcount])) {
            has_interval = 1
            p_end = rcount - 3
          }
        }
        if (!has_interval && rcount >= 2 && rq[rcount - 1] == 0 && tolower(rtok[rcount - 1]) == "every" && rq[rcount] == 0) {
          check_fractional_compact(rtok[rcount])
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
      if (wcount > 0) {
        printf ",\"warnings\":["
        for (i = 1; i <= wcount; i++) {
          if (i > 1) printf ","
          printf "\"%s\"", json_escape(warnings[i])
        }
        printf "]"
      }
      printf "}\n"
      finish_ok()
    }

    BEGIN {
      init_tables()
      init_flag_hints()
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
    function init_sj_tables(    i) {
      for (i = 1; i < 256; i++) {
        ord[sprintf("%c", i)] = i
      }
      posix_cls["alnum"] = "0-9A-Za-z"
      posix_cls["alpha"] = "A-Za-z"
      posix_cls["blank"] = " \t"
      posix_cls["cntrl"] = sprintf("%c-%c%c", 1, 31, 127)
      posix_cls["digit"] = "0-9"
      posix_cls["graph"] = "!-~"
      posix_cls["lower"] = "a-z"
      posix_cls["print"] = " -~"
      posix_cls["punct"] = "!-/:-@[-`{-~"
      posix_cls["space"] = " \t\n\r\f" sprintf("%c", 11)
      posix_cls["upper"] = "A-Z"
      posix_cls["xdigit"] = "0-9A-Fa-f"
    }

    function compile_safe_ere(pat,    n, i, ch, nx, out, in_class, c_start, prev_ch, paren_depth, expect_atom, last_quant, group_start, cls_end, cls_name, hi_ch, q_start, j, m_str, comma_pos, m_val, n_val, k, p_d, ok_end, c2) {
      n = length(pat)
      if (n == 0) return ""
      out = ""
      in_class = 0
      c_start = 0
      prev_ch = ""
      paren_depth = 0
      expect_atom = 1
      last_quant = 0
      group_start[0] = 1

      i = 1
      while (i <= n) {
        ch = substr(pat, i, 1)
        if (in_class) {
          if (i == c_start && ch == "^") {
            out = out "^"
            i++
            c_start = i
            continue
          }
          if (ch == "]" && i == c_start) return ""
          if (ch == "]") {
            in_class = 0
            out = out "]"
            expect_atom = 0
            last_quant = 0
            prev_ch = ""
            i++
            continue
          }
          if (ch == "[" && i < n) {
            nx = substr(pat, i + 1, 1)
            if (nx == ":") {
              cls_end = 0
              for (j = i + 2; j < n; j++) {
                if (substr(pat, j, 2) == ":]") {
                  cls_end = j
                  break
                }
              }
              if (cls_end == 0) return ""
              cls_name = substr(pat, i + 2, cls_end - (i + 2))
              if (!(cls_name in posix_cls)) return ""
              out = out posix_cls[cls_name]
              prev_ch = ""
              i = cls_end + 2
              continue
            }
            if (nx == "." || nx == "=") return ""
          }
          if (ch == "\\") {
            if (i == n) return ""
            nx = substr(pat, i + 1, 1)
            if (nx == "]" || nx == "[" || nx == "-" || nx == "\\" || nx == "^") return ""
            if (nx == "d" || nx == "D" || nx == "w" || nx == "W" || nx == "s" || nx == "S") return ""
            if (nx == "n") nx = "\n"
            else if (nx == "r") nx = "\r"
            else if (nx == "t") nx = "\t"
            out = out nx
            prev_ch = nx
            i += 2
            continue
          }
          if (ch == "-" && prev_ch != "" && i < n && substr(pat, i + 1, 1) != "]") {
            hi_ch = substr(pat, i + 1, 1)
            if (hi_ch == "\\" || hi_ch == "[") return ""
            if (ord[prev_ch] > ord[hi_ch]) return ""
            out = out "-" hi_ch
            prev_ch = ""
            i += 2
            continue
          }
          out = out ch
          prev_ch = ch
          i++
          continue
        }

        if (ch == "\\") {
          if (i == n) return ""
          nx = substr(pat, i + 1, 1)
          if (nx == "d") {
            out = out "[0-9]"
          } else if (nx == "w") {
            out = out "[A-Za-z0-9_]"
          } else if (nx == "s") {
            out = out "[ \t\r\n]"
          } else if (nx == "D" || nx == "W" || nx == "S" || nx == "b" || nx == "B" || nx == "p" || nx == "P" || nx == "k" || (nx >= "0" && nx <= "9")) {
            return ""
          } else {
            out = out "\\" nx
          }
          expect_atom = 0
          last_quant = 0
          i += 2
          continue
        }

        if (ch == "[") {
          in_class = 1
          c_start = i + 1
          prev_ch = ""
          out = out "["
          i++
          continue
        }

        if (ch == "(") {
          if (substr(pat, i, 2) == "(?") {
            if (substr(pat, i, 3) == "(?:") {
              paren_depth++
              group_start[paren_depth] = (expect_atom && group_start[paren_depth - 1]) ? 1 : 0
              out = out "("
              expect_atom = 1
              last_quant = 0
              i += 3
              continue
            }
            return ""
          }
          paren_depth++
          group_start[paren_depth] = (expect_atom && group_start[paren_depth - 1]) ? 1 : 0
          out = out "("
          expect_atom = 1
          last_quant = 0
          i++
          continue
        }

        if (ch == ")") {
          if (paren_depth == 0 || expect_atom == 1) return ""
          paren_depth--
          out = out ")"
          expect_atom = 0
          last_quant = 0
          i++
          continue
        }

        if (ch == "|") {
          if (expect_atom == 1) return ""
          out = out "|"
          expect_atom = 1
          last_quant = 0
          i++
          continue
        }

        if (ch == "*" || ch == "+" || ch == "?") {
          if (expect_atom == 1 || last_quant == 1) return ""
          out = out ch
          expect_atom = 0
          last_quant = 1
          i++
          continue
        }

        if (ch == "{") {
          if (expect_atom == 1 || last_quant == 1) return ""
          q_start = i + 1
          j = q_start
          while (j <= n && substr(pat, j, 1) != "}") j++
          if (j > n) return ""
          m_str = substr(pat, q_start, j - q_start)
          if (m_str !~ /^[0-9]+(,[0-9]*)?$/) return ""
          comma_pos = index(m_str, ",")
          if (comma_pos > 0) {
            m_val = substr(m_str, 1, comma_pos - 1) + 0
            if (m_val > 255) return ""
            if (comma_pos < length(m_str)) {
              n_val = substr(m_str, comma_pos + 1) + 0
              if (n_val > 255 || m_val > n_val) return ""
            }
          } else {
            m_val = m_str + 0
            if (m_val > 255) return ""
          }
          out = out "{" m_str "}"
          expect_atom = 0
          last_quant = 1
          i = j + 1
          continue
        }

        if (ch == "^") {
          if (expect_atom == 1 && group_start[paren_depth] == 1) {
            i++
            continue
          }
          return ""
        }

        if (ch == "$") {
          k = i + 1
          p_d = paren_depth
          ok_end = 1
          while (k <= n) {
            c2 = substr(pat, k, 1)
            if (c2 == ")") {
              if (p_d == 0) {
                ok_end = 0
                break
              }
              p_d--
              k++
              continue
            }
            if (c2 == "|" && p_d == 0) {
              break
            }
            if (c2 == "|" && p_d > 0) {
              # Skip rest of sibling branches in this group up to matching )
              j = p_d
              k++
              while (k <= n && j >= p_d) {
                c2 = substr(pat, k, 1)
                if (c2 == "\\") {
                  k += 2
                  continue
                }
                if (c2 == "(") j++
                else if (c2 == ")") j--
                k++
              }
              if (j >= p_d) {
                ok_end = 0
                break
              }
              p_d--
              continue
            }
            ok_end = 0
            break
          }
          if (!ok_end) return ""
          i++
          continue
        }

        out = out ch
        expect_atom = 0
        last_quant = 0
        i++
      }

      if (in_class || paren_depth != 0 || expect_atom == 1 || out == "") return ""
      return out
    }

    function pattern_matches_loop(pat,    ere) {
      if (pat == "") return 0
      if (pat == "loop" || pat == "agy-loop" || pat == "agy-loop:loop" || pat == "*" || pat == ".*") {
        return 1
      }
      ere = compile_safe_ere(pat)
      if (ere == "") return 0
      ere = "^(" ere ")$"
      if ("loop" ~ ere) return 1
      if ("agy-loop" ~ ere) return 1
      if ("agy-loop:loop" ~ ere) return 1
      return 0
    }

    function skip_json_val(    d) {
      if (pos > ntk) {
        parse_err = 1
        return
      }
      if (tk_type[pos] == "STR" || tk_type[pos] == "LIT") {
        pos++
        return
      }
      if (tk_type[pos] == "SYM" && (tk_val[pos] == "{" || tk_val[pos] == "[")) {
        d = 0
        while (pos <= ntk) {
          if (tk_type[pos] == "SYM" && (tk_val[pos] == "{" || tk_val[pos] == "[")) d++
          else if (tk_type[pos] == "SYM" && (tk_val[pos] == "}" || tk_val[pos] == "]")) {
            d--
            if (d == 0) {
              pos++
              return
            }
          }
          pos++
        }
        parse_err = 1
        return
      }
      parse_err = 1
    }

    function inspect_pattern_array(    matched_loop) {
      if (pos > ntk || tk_type[pos] != "SYM" || tk_val[pos] != "[") {
        skip_json_val()
        return -1
      }
      pos++
      matched_loop = 0
      while (pos <= ntk) {
        if (tk_type[pos] == "SYM" && tk_val[pos] == "]") {
          pos++
          return matched_loop
        }
        if (tk_type[pos] == "SYM" && tk_val[pos] == ",") {
          pos++
          continue
        }
        if (tk_type[pos] == "STR") {
          if (pattern_matches_loop(tk_val[pos])) {
            matched_loop = 1
          }
          pos++
        } else {
          skip_json_val()
          if (parse_err) return -1
        }
      }
      parse_err = 1
      return -1
    }

    function inspect_entry_object(    ekey, mres) {
      if (pos > ntk || tk_type[pos] != "SYM" || tk_val[pos] != "{") {
        skip_json_val()
        return
      }
      pos++
      while (pos <= ntk) {
        if (tk_type[pos] == "SYM" && tk_val[pos] == "}") {
          pos++
          return
        }
        if (tk_type[pos] == "SYM" && tk_val[pos] == ",") {
          pos++
          continue
        }
        if (tk_type[pos] != "STR") {
          parse_err = 1
          return
        }
        ekey = tk_val[pos]
        pos++
        if (pos > ntk || tk_type[pos] != "SYM" || tk_val[pos] != ":") {
          parse_err = 1
          return
        }
        pos++
        if (ekey == "include_only" && pos <= ntk && tk_type[pos] == "SYM" && tk_val[pos] == "[") {
          mres = inspect_pattern_array()
          if (mres == 0) has_inc_warn = 1
        } else if (ekey == "exclude" && pos <= ntk && tk_type[pos] == "SYM" && tk_val[pos] == "[") {
          mres = inspect_pattern_array()
          if (mres == 1) has_exc_warn = 1
        } else {
          skip_json_val()
        }
        if (parse_err) return
      }
      parse_err = 1
    }

    function inspect_entries_array() {
      if (pos > ntk || tk_type[pos] != "SYM" || tk_val[pos] != "[") {
        skip_json_val()
        return
      }
      pos++
      while (pos <= ntk) {
        if (tk_type[pos] == "SYM" && tk_val[pos] == "]") {
          pos++
          return
        }
        if (tk_type[pos] == "SYM" && tk_val[pos] == ",") {
          pos++
          continue
        }
        if (tk_type[pos] == "SYM" && tk_val[pos] == "{") {
          inspect_entry_object()
        } else {
          skip_json_val()
        }
        if (parse_err) return
      }
      parse_err = 1
    }

    BEGIN {
      init_sj_tables()
      raw = ""
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
              else if (nx == "b") sval = sval "\b"
              else if (nx == "f") sval = sval "\f"
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
      parse_err = 0
      pos = 1

      if (ntk == 0) {
        printf "%s: invalid JSON/JSONC (empty)\n", sj
        exit 0
      }

      if (tk_type[1] == "SYM" && tk_val[1] == "{") {
        pos = 2
        while (pos <= ntk) {
          if (tk_type[pos] == "SYM" && tk_val[pos] == "}") {
            pos++
            break
          }
          if (tk_type[pos] == "SYM" && tk_val[pos] == ",") {
            pos++
            continue
          }
          if (tk_type[pos] != "STR") {
            parse_err = 1
            break
          }
          key = tk_val[pos]
          pos++
          if (pos > ntk || tk_type[pos] != "SYM" || tk_val[pos] != ":") {
            parse_err = 1
            break
          }
          pos++
          if (key == "include_only" && pos <= ntk && tk_type[pos] == "SYM" && tk_val[pos] == "[") {
            mres = inspect_pattern_array()
            if (mres == 0) has_inc_warn = 1
          } else if (key == "exclude" && pos <= ntk && tk_type[pos] == "SYM" && tk_val[pos] == "[") {
            mres = inspect_pattern_array()
            if (mres == 1) has_exc_warn = 1
          } else if ((key == "entries" || key == "inherits") && pos <= ntk && tk_type[pos] == "SYM" && tk_val[pos] == "[") {
            inspect_entries_array()
          } else {
            skip_json_val()
          }
          if (parse_err) break
        }
        if (pos <= ntk) parse_err = 1
      } else {
        skip_json_val()
        if (pos <= ntk) parse_err = 1
      }

      if (parse_err) {
        printf "%s: invalid JSON/JSONC\n", sj
        exit 0
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

emit_json_error() {
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
      printf "{\"error\":\"%s\"}\n", json_escape(ARGV[2])
      exit 2
    }
  ' SENTINEL "$1"
}

move_shadow_path() {
  _src="$1"
  _dest="$2"
  mkdir -p "$(dirname -- "$_dest")"
  if ! mv "$_src" "$_dest" 2>/dev/null; then
    cp -RPp "$_src" "$_dest"
    rm -rf "$_src"
  fi
}

resolve_state_root() {
  if [ -n "${AGY_LOOP_STATE_DIR:-}" ]; then
    normalize_dir "$AGY_LOOP_STATE_DIR"
  else
    _sr_ws="$(normalize_dir "${1:-$PWD}")"
    if [ "$_sr_ws" = "/" ]; then
      printf '/.agents/.agy-loop'
    else
      printf '%s/.agents/.agy-loop' "$_sr_ws"
    fi
  fi
}

validate_loop_id() {
  _lid="${1:-}"
  case "$_lid" in
    lp_*) ;;
    *) return 1 ;;
  esac
  _suf="${_lid#lp_}"
  _len=${#_suf}
  if [ "$_len" -lt 4 ] || [ "$_len" -gt 64 ]; then
    return 1
  fi
  case "$_suf" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) return 1 ;;
  esac
  return 0
}

generate_loop_id() {
  _gl_root="$1"
  _attempt=0
  while [ "$_attempt" -lt 16 ]; do
    _ts="$(date -u +%Y%m%dT%H%M%SZ)"
    _hex="$(dd if=/dev/urandom bs=2 count=1 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \t\r\n' | tr 'A-F' 'a-f' || true)"
    case "$_hex" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *)
        _hex="$(LP_PID="$$" LP_ATT="$_attempt" LP_SEC="$(date -u +%H%M%S)" POSIXLY_CORRECT=1 LC_ALL=C awk 'BEGIN { srand(ENVIRON["LP_PID"] + ENVIRON["LP_ATT"] * 31 + ENVIRON["LP_SEC"]); printf "%04x", int(rand() * 65536) }')"
        ;;
    esac
    _cand="lp_${_ts}_${_hex}"
    if [ ! -e "$_gl_root/loops/$_cand" ]; then
      printf '%s' "$_cand"
      return 0
    fi
    _attempt=$((_attempt + 1))
  done
  return 1
}

write_state_atomic() {
  _wsa_dir="$1"
  _wsa_json="$2"
  _wsa_tmp="$_wsa_dir/state.json.tmp.$$"
  printf '%s\n' "$_wsa_json" > "$_wsa_tmp"
  mv -f "$_wsa_tmp" "$_wsa_dir/state.json"
}

run_state_engine() {
  POSIXLY_CORRECT=1 LC_ALL=C awk '
    function init_json_tables(    i, c) {
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
        if (ch in esc) out = out esc[ch]
        else out = out ch
      }
      return out
    }

    function json_error(msg) {
      printf "{\"error\":\"%s\"}\n", json_escape(msg)
      exit 2
    }

    function hex_val(ch) {
      if (ch >= "0" && ch <= "9") return ord[ch] - 48
      if (ch >= "a" && ch <= "f") return ord[ch] - 87
      if (ch >= "A" && ch <= "F") return ord[ch] - 55
      return -1
    }

    function hex4(s,    v0, v1, v2, v3) {
      if (length(s) != 4) return -1
      v0 = hex_val(substr(s, 1, 1))
      v1 = hex_val(substr(s, 2, 1))
      v2 = hex_val(substr(s, 3, 1))
      v3 = hex_val(substr(s, 4, 1))
      if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return -1
      return v0 * 4096 + v1 * 256 + v2 * 16 + v3
    }

    function cp_to_utf8(cp,    b1, b2, b3, b4) {
      if (cp <= 0) return ""
      if (cp < 128) return sprintf("%c", cp)
      if (cp < 2048) {
        b1 = 192 + int(cp / 64)
        b2 = 128 + (cp % 64)
        return sprintf("%c%c", b1, b2)
      }
      if (cp < 65536) {
        b1 = 224 + int(cp / 4096)
        b2 = 128 + (int(cp / 64) % 64)
        b3 = 128 + (cp % 64)
        return sprintf("%c%c%c", b1, b2, b3)
      }
      b1 = 240 + int(cp / 262144)
      b2 = 128 + (int(cp / 4096) % 64)
      b3 = 128 + (int(cp / 64) % 64)
      b4 = 128 + (cp % 64)
      return sprintf("%c%c%c%c", b1, b2, b3, b4)
    }

    function json_parse_obj_top(raw, out_type, out_val,    n, i, ch, ntk, tkt, tkv, sval, closed, sc, nx, cp, cp2, j, c2, pos, key, d, lit, ok_root) {
      split("", out_type)
      split("", out_val)
      n = length(raw)
      i = 1
      ntk = 0
      while (i <= n) {
        ch = substr(raw, i, 1)
        if (ch == " " || ch == "\t" || ch == "\r" || ch == "\n") {
          i++
          continue
        }
        if (ch == "\"") {
          sval = ""
          i++
          closed = 0
          while (i <= n) {
            sc = substr(raw, i, 1)
            if (sc == "\\") {
              if (i >= n) return 0
              nx = substr(raw, i + 1, 1)
              if (nx == "\"" || nx == "\\" || nx == "/") {
                sval = sval nx; i += 2
              } else if (nx == "b") {
                sval = sval "\b"; i += 2
              } else if (nx == "f") {
                sval = sval "\f"; i += 2
              } else if (nx == "n") {
                sval = sval "\n"; i += 2
              } else if (nx == "r") {
                sval = sval "\r"; i += 2
              } else if (nx == "t") {
                sval = sval "\t"; i += 2
              } else if (nx == "u") {
                if (i + 5 > n) return 0
                cp = hex4(substr(raw, i + 2, 4))
                if (cp < 0) return 0
                if (cp >= 55296 && cp <= 56319 && i + 11 <= n && substr(raw, i + 6, 2) == "\\u") {
                  cp2 = hex4(substr(raw, i + 8, 4))
                  if (cp2 >= 56320 && cp2 <= 57343) {
                    cp = 65536 + (cp - 55296) * 1024 + (cp2 - 56320)
                    sval = sval cp_to_utf8(cp)
                    i += 12
                    continue
                  }
                }
                sval = sval cp_to_utf8(cp)
                i += 6
              } else {
                return 0
              }
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
          if (!closed) return 0
          ntk++
          tkt[ntk] = "STR"
          tkv[ntk] = sval
          continue
        }
        if (ch == ":" || ch == "[" || ch == "]" || ch == "{" || ch == "}" || ch == ",") {
          ntk++
          tkt[ntk] = "SYM"
          tkv[ntk] = ch
          i++
          continue
        }
        j = i
        while (j <= n) {
          c2 = substr(raw, j, 1)
          if (c2 == " " || c2 == "\t" || c2 == "\r" || c2 == "\n" || c2 == "\"" || c2 == ":" || c2 == "[" || c2 == "]" || c2 == "{" || c2 == "}" || c2 == ",") {
            break
          }
          j++
        }
        ntk++
        tkt[ntk] = "LIT"
        tkv[ntk] = substr(raw, i, j - i)
        i = j
      }

      if (ntk < 2 || tkt[1] != "SYM" || tkv[1] != "{") return 0
      pos = 2
      ok_root = 0
      while (pos <= ntk) {
        if (tkt[pos] == "SYM" && tkv[pos] == "}") {
          pos++
          ok_root = 1
          break
        }
        if (tkt[pos] == "SYM" && tkv[pos] == ",") {
          pos++
          continue
        }
        if (tkt[pos] != "STR") return 0
        key = tkv[pos]
        pos++
        if (pos > ntk || tkt[pos] != "SYM" || tkv[pos] != ":") return 0
        pos++
        if (pos > ntk) return 0
        if (tkt[pos] == "STR") {
          out_type[key] = "str"
          out_val[key] = tkv[pos]
          pos++
        } else if (tkt[pos] == "LIT") {
          lit = tkv[pos]
          if (lit == "true") {
            out_type[key] = "bool"
            out_val[key] = 1
          } else if (lit == "false") {
            out_type[key] = "bool"
            out_val[key] = 0
          } else if (lit == "null") {
            out_type[key] = "null"
            out_val[key] = ""
          } else if (lit ~ /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) {
            out_type[key] = "num"
            out_val[key] = lit + 0
          } else {
            return 0
          }
          pos++
        } else if (tkt[pos] == "SYM" && (tkv[pos] == "{" || tkv[pos] == "[")) {
          d = 0
          while (pos <= ntk) {
            if (tkt[pos] == "SYM" && (tkv[pos] == "{" || tkv[pos] == "[")) d++
            else if (tkt[pos] == "SYM" && (tkv[pos] == "}" || tkv[pos] == "]")) {
              d--
              if (d == 0) {
                pos++
                break
              }
            }
            pos++
          }
          if (d != 0) return 0
          out_type[key] = "complex"
          out_val[key] = ""
        } else {
          return 0
        }
      }
      if (!ok_root || pos <= ntk) return 0
      return 1
    }

    function read_file_raw(fpath,    ln, raw, first) {
      raw = ""
      first = 1
      while ((getline ln < fpath) > 0) {
        raw = first ? ln : (raw "\n" ln)
        first = 0
      }
      close(fpath)
      return raw
    }

    function valid_status(s) {
      return (s == "running" || s == "done" || s == "blocked" || s == "stopped" || s == "max_reached" || s == "circuit_broken")
    }

    function json_str_val(s) {
      return "\"" json_escape(s) "\""
    }

    function json_nullable_str(t, v) {
      if (t == "null" || t == "") return "null"
      return "\"" json_escape(v) "\""
    }

    function json_nullable_int(t, v) {
      if (t == "null" || t == "") return "null"
      return sprintf("%d", v + 0)
    }

    function format_state_json(st_t, st_v,    out) {
      out = "{"
      out = out "\"schema_version\":" sprintf("%d", st_v["schema_version"] + 0)
      out = out ",\"loop_id\":" json_str_val(st_v["loop_id"])
      out = out ",\"status\":" json_str_val(st_v["status"])
      out = out ",\"workspace_dir\":" json_str_val(st_v["workspace_dir"])
      out = out ",\"task_source\":" json_str_val(st_v["task_source"])
      out = out ",\"inline_prompt\":" json_str_val(st_v["inline_prompt"])
      out = out ",\"pacing\":" json_str_val(st_v["pacing"])
      out = out ",\"once\":" (st_v["once"] ? "true" : "false")
      out = out ",\"interval_sec\":" json_nullable_int(st_t["interval_sec"], st_v["interval_sec"])
      out = out ",\"interval_label\":" json_nullable_str(st_t["interval_label"], st_v["interval_label"])
      out = out ",\"cron_expr\":" json_nullable_str(st_t["cron_expr"], st_v["cron_expr"])
      out = out ",\"use_cron\":" (st_v["use_cron"] ? "true" : "false")
      out = out ",\"exact_timing\":" (st_v["exact_timing"] ? "true" : "false")
      out = out ",\"is_daemon\":" (st_v["is_daemon"] ? "true" : "false")
      out = out ",\"state_mode\":" json_str_val(st_v["state_mode"])
      out = out ",\"workspace\":" json_str_val(st_v["workspace"])
      out = out ",\"model\":" json_nullable_str(st_t["model"], st_v["model"])
      out = out ",\"delegate\":" json_str_val(st_v["delegate"])
      out = out ",\"iteration\":" sprintf("%d", st_v["iteration"] + 0)
      out = out ",\"max_iterations\":" sprintf("%d", st_v["max_iterations"] + 0)
      out = out ",\"consecutive_errors\":" sprintf("%d", st_v["consecutive_errors"] + 0)
      out = out ",\"task_id\":" json_nullable_str(st_t["task_id"], st_v["task_id"])
      out = out ",\"worker_id\":" json_nullable_str(st_t["worker_id"], st_v["worker_id"])
      out = out ",\"worktree_branch\":" json_nullable_str(st_t["worktree_branch"], st_v["worktree_branch"])
      out = out ",\"last_status\":" json_nullable_str(st_t["last_status"], st_v["last_status"])
      out = out ",\"last_delay_sec\":" json_nullable_int(st_t["last_delay_sec"], st_v["last_delay_sec"])
      out = out ",\"last_summary\":" json_nullable_str(st_t["last_summary"], st_v["last_summary"])
      out = out ",\"next_hint\":" json_nullable_str(st_t["next_hint"], st_v["next_hint"])
      out = out ",\"stop_requested\":" (st_v["stop_requested"] ? "true" : "false")
      out = out ",\"stop_mode\":" json_nullable_str(st_t["stop_mode"], st_v["stop_mode"])
      out = out ",\"created_at\":" json_str_val(st_v["created_at"])
      out = out ",\"updated_at\":" json_str_val(st_v["updated_at"])
      out = out "}"
      return out
    }

    function format_doctor_summary(st_t, st_v,    out) {
      out = "{"
      out = out "\"loop_id\":" json_str_val(st_v["loop_id"])
      out = out ",\"iteration\":" sprintf("%d", st_v["iteration"] + 0)
      out = out ",\"max_iterations\":" sprintf("%d", st_v["max_iterations"] + 0)
      out = out ",\"pacing\":" json_str_val(st_v["pacing"])
      out = out ",\"status\":" json_str_val(st_v["status"])
      out = out ",\"task_id\":" json_nullable_str(st_t["task_id"], st_v["task_id"])
      out = out ",\"worker_id\":" json_nullable_str(st_t["worker_id"], st_v["worker_id"])
      out = out ",\"updated_at\":" json_str_val(st_v["updated_at"])
      out = out "}"
      return out
    }

    function format_event_json(ev_name, st_t, st_v,    out) {
      out = "{"
      out = out "\"ts\":" json_str_val(st_v["updated_at"])
      out = out ",\"event\":" json_str_val(ev_name)
      out = out ",\"loop_id\":" json_str_val(st_v["loop_id"])
      out = out ",\"iteration\":" sprintf("%d", st_v["iteration"] + 0)
      out = out ",\"status\":" json_str_val(st_v["status"])
      out = out ",\"last_status\":" json_nullable_str(st_t["last_status"], st_v["last_status"])
      out = out ",\"consecutive_errors\":" sprintf("%d", st_v["consecutive_errors"] + 0)
      out = out "}"
      return out
    }

    function load_state_defaults(st_t, st_v) {
      st_t["schema_version"] = "num"; st_v["schema_version"] = 1
      st_t["loop_id"] = "str"; st_v["loop_id"] = ""
      st_t["status"] = "str"; st_v["status"] = "running"
      st_t["workspace_dir"] = "str"; st_v["workspace_dir"] = ""
      st_t["task_source"] = "str"; st_v["task_source"] = "loop_md_or_default"
      st_t["inline_prompt"] = "str"; st_v["inline_prompt"] = ""
      st_t["pacing"] = "str"; st_v["pacing"] = "dynamic"
      st_t["once"] = "bool"; st_v["once"] = 0
      st_t["interval_sec"] = "null"; st_v["interval_sec"] = ""
      st_t["interval_label"] = "null"; st_v["interval_label"] = ""
      st_t["cron_expr"] = "null"; st_v["cron_expr"] = ""
      st_t["use_cron"] = "bool"; st_v["use_cron"] = 0
      st_t["exact_timing"] = "bool"; st_v["exact_timing"] = 0
      st_t["is_daemon"] = "bool"; st_v["is_daemon"] = 0
      st_t["state_mode"] = "str"; st_v["state_mode"] = "fresh"
      st_t["workspace"] = "str"; st_v["workspace"] = "inherit"
      st_t["model"] = "null"; st_v["model"] = ""
      st_t["delegate"] = "str"; st_v["delegate"] = "loop-worker"
      st_t["iteration"] = "num"; st_v["iteration"] = 1
      st_t["max_iterations"] = "num"; st_v["max_iterations"] = 20
      st_t["consecutive_errors"] = "num"; st_v["consecutive_errors"] = 0
      st_t["task_id"] = "null"; st_v["task_id"] = ""
      st_t["worker_id"] = "null"; st_v["worker_id"] = ""
      st_t["worktree_branch"] = "null"; st_v["worktree_branch"] = ""
      st_t["last_status"] = "null"; st_v["last_status"] = ""
      st_t["last_delay_sec"] = "null"; st_v["last_delay_sec"] = ""
      st_t["last_summary"] = "null"; st_v["last_summary"] = ""
      st_t["next_hint"] = "str"; st_v["next_hint"] = "None"
      st_t["stop_requested"] = "bool"; st_v["stop_requested"] = 0
      st_t["stop_mode"] = "null"; st_v["stop_mode"] = ""
      st_t["created_at"] = "str"; st_v["created_at"] = ""
      st_t["updated_at"] = "str"; st_v["updated_at"] = ""
    }

    function apply_existing_state(in_t, in_v, st_t, st_v,    k) {
      load_state_defaults(st_t, st_v)
      for (k in st_t) {
        if (k in in_t && in_t[k] != "complex") {
          st_t[k] = in_t[k]
          st_v[k] = in_v[k]
        }
      }
      if (st_t["loop_id"] != "str" || st_v["loop_id"] == "" || !valid_status(st_v["status"])) {
        return 0
      }
      return 1
    }

    function apply_patch_fields(pt_t, pt_v, st_t, st_v) {
      if ("status" in pt_t) {
        if (pt_t["status"] != "str" || !valid_status(pt_v["status"])) {
          json_error("Invalid status value in JSON patch")
        }
        st_t["status"] = "str"; st_v["status"] = pt_v["status"]
      }
      if ("iteration" in pt_t) {
        if (pt_t["iteration"] != "num" || pt_v["iteration"] < 1 || int(pt_v["iteration"]) != pt_v["iteration"]) {
          json_error("Invalid iteration value in JSON patch")
        }
        st_t["iteration"] = "num"; st_v["iteration"] = int(pt_v["iteration"])
      }
      if ("max_iterations" in pt_t) {
        if (pt_t["max_iterations"] != "num" || pt_v["max_iterations"] < 1 || int(pt_v["max_iterations"]) != pt_v["max_iterations"]) {
          json_error("Invalid max_iterations value in JSON patch")
        }
        st_t["max_iterations"] = "num"; st_v["max_iterations"] = int(pt_v["max_iterations"])
      }
      if ("consecutive_errors" in pt_t) {
        if (pt_t["consecutive_errors"] != "num" || pt_v["consecutive_errors"] < 0 || int(pt_v["consecutive_errors"]) != pt_v["consecutive_errors"]) {
          json_error("Invalid consecutive_errors value in JSON patch")
        }
        st_t["consecutive_errors"] = "num"; st_v["consecutive_errors"] = int(pt_v["consecutive_errors"])
      }
      if ("task_id" in pt_t) {
        if (pt_t["task_id"] == "null") {
          st_t["task_id"] = "null"; st_v["task_id"] = ""
        } else if (pt_t["task_id"] == "str") {
          st_t["task_id"] = "str"; st_v["task_id"] = pt_v["task_id"]
        } else {
          json_error("Invalid task_id in JSON patch")
        }
      }
      if ("worker_id" in pt_t) {
        if (pt_t["worker_id"] == "null") {
          st_t["worker_id"] = "null"; st_v["worker_id"] = ""
        } else if (pt_t["worker_id"] == "str") {
          st_t["worker_id"] = "str"; st_v["worker_id"] = pt_v["worker_id"]
        } else {
          json_error("Invalid worker_id in JSON patch")
        }
      }
      if ("worktree_branch" in pt_t) {
        if (pt_t["worktree_branch"] == "null") {
          st_t["worktree_branch"] = "null"; st_v["worktree_branch"] = ""
        } else if (pt_t["worktree_branch"] == "str") {
          st_t["worktree_branch"] = "str"; st_v["worktree_branch"] = pt_v["worktree_branch"]
        } else {
          json_error("Invalid worktree_branch in JSON patch")
        }
      }
      if ("last_status" in pt_t) {
        if (pt_t["last_status"] == "null") {
          st_t["last_status"] = "null"; st_v["last_status"] = ""
        } else if (pt_t["last_status"] == "str") {
          st_t["last_status"] = "str"; st_v["last_status"] = pt_v["last_status"]
        } else {
          json_error("Invalid last_status in JSON patch")
        }
      }
      if ("last_delay_sec" in pt_t) {
        if (pt_t["last_delay_sec"] == "null") {
          st_t["last_delay_sec"] = "null"; st_v["last_delay_sec"] = ""
        } else if (pt_t["last_delay_sec"] == "num" && pt_v["last_delay_sec"] >= 0 && int(pt_v["last_delay_sec"]) == pt_v["last_delay_sec"]) {
          st_t["last_delay_sec"] = "num"; st_v["last_delay_sec"] = int(pt_v["last_delay_sec"])
        } else {
          json_error("Invalid last_delay_sec in JSON patch")
        }
      }
      if ("last_summary" in pt_t) {
        if (pt_t["last_summary"] == "null") {
          st_t["last_summary"] = "null"; st_v["last_summary"] = ""
        } else if (pt_t["last_summary"] == "str") {
          st_t["last_summary"] = "str"; st_v["last_summary"] = pt_v["last_summary"]
        } else {
          json_error("Invalid last_summary in JSON patch")
        }
      }
      if ("next_hint" in pt_t) {
        if (pt_t["next_hint"] == "null") {
          st_t["next_hint"] = "str"; st_v["next_hint"] = "None"
        } else if (pt_t["next_hint"] == "str") {
          st_t["next_hint"] = "str"; st_v["next_hint"] = pt_v["next_hint"]
        } else {
          json_error("Invalid next_hint in JSON patch")
        }
      }
      if ("stop_requested" in pt_t) {
        if (pt_t["stop_requested"] != "bool") {
          json_error("Invalid stop_requested in JSON patch")
        }
        st_t["stop_requested"] = "bool"; st_v["stop_requested"] = pt_v["stop_requested"]
      }
      if ("stop_mode" in pt_t) {
        if (pt_t["stop_mode"] == "null") {
          st_t["stop_mode"] = "null"; st_v["stop_mode"] = ""
        } else if (pt_t["stop_mode"] == "str") {
          st_t["stop_mode"] = "str"; st_v["stop_mode"] = pt_v["stop_mode"]
        } else {
          json_error("Invalid stop_mode in JSON patch")
        }
      }
      if ("increment_iteration" in pt_t && pt_t["increment_iteration"] == "bool" && pt_v["increment_iteration"]) {
        st_v["iteration"] = st_v["iteration"] + 1
      }
      if ("increment_errors" in pt_t && pt_t["increment_errors"] == "bool" && pt_v["increment_errors"]) {
        st_v["consecutive_errors"] = st_v["consecutive_errors"] + 1
      }
      if ("reset_errors" in pt_t && pt_t["reset_errors"] == "bool" && pt_v["reset_errors"]) {
        st_v["consecutive_errors"] = 0
      }
    }

    function read_stdin_all(    ln, buf, first) {
      buf = ""
      first = 1
      while ((getline ln) > 0) {
        buf = first ? ln : (buf "\n" ln)
        first = 0
      }
      return buf
    }

    function next_flag_val(idx, argc, flag_name, eq_pos, tok,    val) {
      if (eq_pos > 0) return substr(tok, eq_pos + 1)
      if (idx + 1 > argc) json_error("Missing value for " flag_name)
      return ""
    }

    BEGIN {
      init_json_tables()
      raw_argc = ARGC - 1
      for (i = 2; i <= raw_argc; i++) {
        raw_argv[i] = ARGV[i]
      }
      ARGC = 1
      op = ENVIRON["LP_OP"]

      if (op == "init") {
        req_stdin = (ENVIRON["LP_REQ_STDIN"] == "1") ? 1 : 0
        raw = read_stdin_all()
        split("", in_t); split("", in_v)
        if (raw ~ /^[ \t\r\n]*$/) {
          if (req_stdin) json_error("Empty stdin JSON for state-init")
        } else {
          if (!json_parse_obj_top(raw, in_t, in_v)) {
            json_error("Invalid JSON input for state-init")
          }
          if ("error" in in_t) {
            json_error("Cannot initialize state from error payload")
          }
          if ("action" in in_t && (in_t["action"] != "str" || in_v["action"] != "run")) {
            json_error("state-init requires action == run")
          }
        }

        load_state_defaults(st_t, st_v)
        st_v["loop_id"] = ENVIRON["LP_LOOP_ID"]
        st_v["workspace_dir"] = ENVIRON["LP_WS_DIR"]
        st_v["created_at"] = ENVIRON["LP_NOW"]
        st_v["updated_at"] = ENVIRON["LP_NOW"]

        if ("task_source" in in_t && in_t["task_source"] == "str") st_v["task_source"] = in_v["task_source"]
        if ("inline_prompt" in in_t && in_t["inline_prompt"] == "str") {
          st_v["inline_prompt"] = in_v["inline_prompt"]
        } else if ("prompt" in in_t && in_t["prompt"] == "str") {
          st_v["inline_prompt"] = in_v["prompt"]
        }
        if ("pacing" in in_t && in_t["pacing"] == "str") st_v["pacing"] = in_v["pacing"]
        if ("once" in in_t && in_t["once"] == "bool") st_v["once"] = in_v["once"]
        if ("interval_sec" in in_t) {
          if (in_t["interval_sec"] == "num") {
            st_t["interval_sec"] = "num"; st_v["interval_sec"] = int(in_v["interval_sec"])
          } else if (in_t["interval_sec"] == "null") {
            st_t["interval_sec"] = "null"; st_v["interval_sec"] = ""
          }
        }
        if ("interval_label" in in_t) {
          if (in_t["interval_label"] == "str") {
            st_t["interval_label"] = "str"; st_v["interval_label"] = in_v["interval_label"]
          } else if (in_t["interval_label"] == "null") {
            st_t["interval_label"] = "null"; st_v["interval_label"] = ""
          }
        }
        if ("cron_expr" in in_t) {
          if (in_t["cron_expr"] == "str") {
            st_t["cron_expr"] = "str"; st_v["cron_expr"] = in_v["cron_expr"]
          } else if (in_t["cron_expr"] == "null") {
            st_t["cron_expr"] = "null"; st_v["cron_expr"] = ""
          }
        }
        if ("use_cron" in in_t && in_t["use_cron"] == "bool") st_v["use_cron"] = in_v["use_cron"]
        if ("exact_timing" in in_t && in_t["exact_timing"] == "bool") st_v["exact_timing"] = in_v["exact_timing"]
        if ("is_daemon" in in_t && in_t["is_daemon"] == "bool") st_v["is_daemon"] = in_v["is_daemon"]
        if ("state_mode" in in_t && in_t["state_mode"] == "str") st_v["state_mode"] = in_v["state_mode"]
        if ("workspace" in in_t && in_t["workspace"] == "str") st_v["workspace"] = in_v["workspace"]
        if ("model" in in_t) {
          if (in_t["model"] == "str") {
            st_t["model"] = "str"; st_v["model"] = in_v["model"]
          } else if (in_t["model"] == "null") {
            st_t["model"] = "null"; st_v["model"] = ""
          }
        }
        if ("delegate" in in_t && in_t["delegate"] == "str") st_v["delegate"] = in_v["delegate"]
        if ("max_iterations" in in_t && in_t["max_iterations"] == "num" && in_v["max_iterations"] >= 1) {
          st_v["max_iterations"] = int(in_v["max_iterations"])
        } else if (st_v["once"]) {
          st_v["max_iterations"] = 1
        }
        if ("task_id" in in_t && in_t["task_id"] == "str") {
          st_t["task_id"] = "str"; st_v["task_id"] = in_v["task_id"]
        }
        if ("worker_id" in in_t && in_t["worker_id"] == "str") {
          st_t["worker_id"] = "str"; st_v["worker_id"] = in_v["worker_id"]
        }
        if ("worktree_branch" in in_t && in_t["worktree_branch"] == "str") {
          st_t["worktree_branch"] = "str"; st_v["worktree_branch"] = in_v["worktree_branch"]
        }

        printf "%s\n", format_state_json(st_t, st_v)
        printf "%s\n", format_event_json("init", st_t, st_v)
        exit 0
      }

      if (op == "update") {
        sfile = ENVIRON["LP_STATE_FILE"]
        sraw = read_file_raw(sfile)
        if (sraw == "" || !json_parse_obj_top(sraw, cur_t, cur_v) || !apply_existing_state(cur_t, cur_v, st_t, st_v)) {
          json_error("Invalid or corrupt state.json for " ENVIRON["LP_LOOP_ID"])
        }
        old_status = st_v["status"]
        old_iter = st_v["iteration"]
        ev_name = ""

        if (ENVIRON["LP_USE_STDIN"] == "1") {
          praw = read_stdin_all()
          if (praw ~ /^[ \t\r\n]*$/ || !json_parse_obj_top(praw, pt_t, pt_v)) {
            json_error("Invalid JSON patch on stdin for state-update")
          }
          apply_patch_fields(pt_t, pt_v, st_t, st_v)
          if ("event" in pt_t) {
            if (pt_t["event"] != "str" || pt_v["event"] == "") {
              json_error("Invalid event field in JSON patch")
            }
            ev_name = pt_v["event"]
          }
        }

        for (i = 2; i <= raw_argc; i++) {
          t = raw_argv[i]
          if (t == "--stdin") continue
          if (t == "--increment-iteration") {
            st_v["iteration"] = st_v["iteration"] + 1
            continue
          }
          if (t == "--increment-errors") {
            st_v["consecutive_errors"] = st_v["consecutive_errors"] + 1
            continue
          }
          if (t == "--reset-errors") {
            st_v["consecutive_errors"] = 0
            continue
          }
          eqp = index(t, "=")
          fname = (eqp > 0) ? substr(t, 1, eqp - 1) : t
          if (fname == "--status" || fname == "--iteration" || fname == "--task-id" || fname == "--worker-id" || fname == "--worktree-branch" || fname == "--last-status" || fname == "--last-delay-sec" || fname == "--last-summary" || fname == "--next-hint" || fname == "--consecutive-errors" || fname == "--event" || fname == "--stop-mode" || fname == "--stop-requested") {
            if (eqp > 0) {
              val = substr(t, eqp + 1)
            } else {
              if (i + 1 > raw_argc) json_error("Missing value for " fname)
              i++
              val = raw_argv[i]
            }
            if (fname == "--status") {
              if (!valid_status(val)) json_error("Invalid --status value: " val)
              st_t["status"] = "str"; st_v["status"] = val
            } else if (fname == "--iteration") {
              if (val !~ /^[1-9][0-9]*$/) json_error("Invalid --iteration value: " val)
              st_t["iteration"] = "num"; st_v["iteration"] = val + 0
            } else if (fname == "--consecutive-errors") {
              if (val !~ /^[0-9]+$/) json_error("Invalid --consecutive-errors value: " val)
              st_t["consecutive_errors"] = "num"; st_v["consecutive_errors"] = val + 0
            } else if (fname == "--last-delay-sec") {
              if (val == "null") {
                st_t["last_delay_sec"] = "null"; st_v["last_delay_sec"] = ""
              } else if (val ~ /^[0-9]+$/) {
                st_t["last_delay_sec"] = "num"; st_v["last_delay_sec"] = val + 0
              } else {
                json_error("Invalid --last-delay-sec value: " val)
              }
            } else if (fname == "--task-id") {
              if (val == "" || val == "null") { st_t["task_id"] = "null"; st_v["task_id"] = "" }
              else { st_t["task_id"] = "str"; st_v["task_id"] = val }
            } else if (fname == "--worker-id") {
              if (val == "" || val == "null") { st_t["worker_id"] = "null"; st_v["worker_id"] = "" }
              else { st_t["worker_id"] = "str"; st_v["worker_id"] = val }
            } else if (fname == "--worktree-branch") {
              if (val == "" || val == "null") { st_t["worktree_branch"] = "null"; st_v["worktree_branch"] = "" }
              else { st_t["worktree_branch"] = "str"; st_v["worktree_branch"] = val }
            } else if (fname == "--last-status") {
              if (val == "null") { st_t["last_status"] = "null"; st_v["last_status"] = "" }
              else { st_t["last_status"] = "str"; st_v["last_status"] = val }
            } else if (fname == "--last-summary") {
              if (val == "null") { st_t["last_summary"] = "null"; st_v["last_summary"] = "" }
              else { st_t["last_summary"] = "str"; st_v["last_summary"] = val }
            } else if (fname == "--next-hint") {
              if (val == "null" || val == "") { st_t["next_hint"] = "str"; st_v["next_hint"] = "None" }
              else { st_t["next_hint"] = "str"; st_v["next_hint"] = val }
            } else if (fname == "--stop-mode") {
              if (val == "" || val == "null") { st_t["stop_mode"] = "null"; st_v["stop_mode"] = "" }
              else { st_t["stop_mode"] = "str"; st_v["stop_mode"] = val }
            } else if (fname == "--stop-requested") {
              if (val == "true" || val == "1") { st_t["stop_requested"] = "bool"; st_v["stop_requested"] = 1 }
              else if (val == "false" || val == "0") { st_t["stop_requested"] = "bool"; st_v["stop_requested"] = 0 }
              else json_error("Invalid --stop-requested value: " val)
            } else if (fname == "--event") {
              if (val == "") json_error("Empty --event value")
              ev_name = val
            }
          } else {
            json_error("Unknown option for state-update: " t)
          }
        }

        st_v["updated_at"] = ENVIRON["LP_NOW"]
        if (ev_name == "" && (st_v["status"] != old_status || st_v["iteration"] != old_iter)) {
          ev_name = "update"
        }
        printf "%s\n", format_state_json(st_t, st_v)
        if (ev_name != "") {
          printf "%s\n", format_event_json(ev_name, st_t, st_v)
        }
        exit 0
      }

      if (op == "list" || op == "doctor_summary") {
        lmode = ENVIRON["LP_MODE"]
        rc = 0
        while ((getline fpath) > 0) {
          if (fpath == "") continue
          sraw = read_file_raw(fpath)
          if (sraw == "" || !json_parse_obj_top(sraw, cur_t, cur_v) || !apply_existing_state(cur_t, cur_v, st_t, st_v)) {
            continue
          }
          if (lmode != "all" && st_v["status"] != "running") {
            continue
          }
          rc++
          rec_upd[rc] = st_v["updated_at"]
          rec_lid[rc] = st_v["loop_id"]
          if (op == "doctor_summary") {
            rec_json[rc] = format_doctor_summary(st_t, st_v)
          } else {
            rec_json[rc] = format_state_json(st_t, st_v)
          }
          order[rc] = rc
        }

        for (i = 2; i <= rc; i++) {
          cur_idx = order[i]
          j = i - 1
          while (j >= 1) {
            cmp_idx = order[j]
            swap_needed = 0
            if (rec_upd[cmp_idx] < rec_upd[cur_idx]) {
              swap_needed = 1
            } else if (rec_upd[cmp_idx] == rec_upd[cur_idx] && rec_lid[cmp_idx] < rec_lid[cur_idx]) {
              swap_needed = 1
            }
            if (!swap_needed) break
            order[j + 1] = order[j]
            j--
          }
          order[j + 1] = cur_idx
        }

        if (op == "doctor_summary") {
          printf "["
          for (i = 1; i <= rc; i++) {
            if (i > 1) printf ","
            printf "%s", rec_json[order[i]]
          }
          printf "]\n"
        } else {
          printf "{\"state_dir\":\"%s\",\"loops\":[", json_escape(ENVIRON["LP_STATE_DIR"])
          for (i = 1; i <= rc; i++) {
            if (i > 1) printf ","
            printf "%s", rec_json[order[i]]
          }
          printf "]}\n"
        }
        exit 0
      }

      if (op == "stop_one") {
        sfile = ENVIRON["LP_STATE_FILE"]
        sraw = read_file_raw(sfile)
        if (sraw == "" || !json_parse_obj_top(sraw, cur_t, cur_v) || !apply_existing_state(cur_t, cur_v, st_t, st_v)) {
          json_error("Invalid or corrupt state.json for " ENVIRON["LP_LOOP_ID"])
        }
        if (st_v["status"] != "running") {
          exit 0
        }
        after_cur = (ENVIRON["LP_AFTER_CURRENT"] == "1") ? 1 : 0
        st_t["stop_requested"] = "bool"
        st_v["stop_requested"] = 1
        st_t["stop_mode"] = "str"
        if (after_cur) {
          st_v["stop_mode"] = "after_current"
        } else {
          st_v["status"] = "stopped"
          st_v["stop_mode"] = "immediate"
        }
        st_v["updated_at"] = ENVIRON["LP_NOW"]
        printf "%s\n", format_state_json(st_t, st_v)
        printf "%s\n", format_event_json("stop", st_t, st_v)
        exit 0
      }

      if (op == "wrap_stopped") {
        printf "{\"state_dir\":\"%s\",\"stopped\":[", json_escape(ENVIRON["LP_STATE_DIR"])
        first = 1
        while ((getline ln) > 0) {
          if (ln == "") continue
          if (!first) printf ","
          printf "%s", ln
          first = 0
        }
        printf "]}\n"
        exit 0
      }
    }
  ' SENTINEL "$@"
}

collect_loop_state_files() {
  _cls_root="$1"
  _cls_loops="$_cls_root/loops"
  if [ ! -d "$_cls_loops" ]; then
    return 0
  fi
  for _cls_sf in "$_cls_loops"/*/state.json; do
    [ -f "$_cls_sf" ] || continue
    _cls_dir="${_cls_sf%/state.json}"
    _cls_lid="${_cls_dir##*/}"
    if validate_loop_id "$_cls_lid"; then
      printf '%s\n' "$_cls_sf"
    fi
  done
}

run_state_init() {
  if [ "$#" -lt 1 ]; then
    emit_json_error "Usage: loop-helper.sh state-init <workspace_dir> [--stdin]"
  fi
  _si_stdin=0
  if [ "$1" = "--stdin" ]; then
    _si_ws="$(normalize_dir "$PWD")"
    _si_stdin=1
    shift
  else
    _si_ws="$(normalize_dir "$1")"
    shift
  fi
  for _arg in "$@"; do
    case "$_arg" in
      --stdin)
        _si_stdin=1
        ;;
      *)
        emit_json_error "Unknown argument for state-init: $_arg"
        ;;
    esac
  done

  _si_root="$(resolve_state_root "$_si_ws")"
  _si_lid="$(generate_loop_id "$_si_root")" || emit_json_error "Failed to generate unique loop_id"
  _si_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  _si_rc=0
  if [ "$_si_stdin" -eq 1 ]; then
    _si_out="$(LP_OP="init" LP_REQ_STDIN=1 LP_WS_DIR="$_si_ws" LP_LOOP_ID="$_si_lid" LP_NOW="$_si_now" run_state_engine)" || _si_rc=$?
  else
    _si_out="$(LP_OP="init" LP_REQ_STDIN=0 LP_WS_DIR="$_si_ws" LP_LOOP_ID="$_si_lid" LP_NOW="$_si_now" run_state_engine </dev/null)" || _si_rc=$?
  fi
  if [ "$_si_rc" -ne 0 ]; then
    if [ -n "$_si_out" ]; then
      printf '%s\n' "$_si_out"
    fi
    exit "$_si_rc"
  fi

  _si_state_line="$(printf '%s\n' "$_si_out" | sed -n '1p')"
  _si_event_line="$(printf '%s\n' "$_si_out" | sed -n '2p')"

  _si_loop_dir="$_si_root/loops/$_si_lid"
  mkdir -p "$_si_loop_dir"
  if [ ! -e "$_si_root/.gitignore" ]; then
    printf '*\n' > "$_si_root/.gitignore"
  fi
  write_state_atomic "$_si_loop_dir" "$_si_state_line"
  printf '%s\n' "$_si_event_line" >> "$_si_loop_dir/events.jsonl"
  printf '%s\n' "$_si_state_line"
}

run_state_read() {
  if [ "$#" -lt 2 ]; then
    emit_json_error "Usage: loop-helper.sh state-read <workspace_dir> <loop_id>"
  fi
  if [ "$#" -gt 2 ]; then
    emit_json_error "Unexpected argument for state-read: $3"
  fi
  _sr_ws="$(normalize_dir "$1")"
  _sr_lid="$2"
  if ! validate_loop_id "$_sr_lid"; then
    emit_json_error "Invalid loop_id: $_sr_lid"
  fi
  _sr_root="$(resolve_state_root "$_sr_ws")"
  _sr_file="$_sr_root/loops/$_sr_lid/state.json"
  if [ ! -f "$_sr_file" ]; then
    emit_json_error "Loop state not found: $_sr_lid"
  fi
  LP_STATE_FILE="$_sr_file" POSIXLY_CORRECT=1 LC_ALL=C awk '
    BEGIN {
      f = ENVIRON["LP_STATE_FILE"]
      raw = ""
      first = 1
      while ((getline ln < f) > 0) {
        raw = first ? ln : (raw "\n" ln)
        first = 0
      }
      close(f)
      if (raw == "") {
        printf "{\"error\":\"Empty or unreadable state.json\"}\n"
        exit 2
      }
      printf "%s\n", raw
      exit 0
    }
  '
}

run_state_update() {
  if [ "$#" -lt 2 ]; then
    emit_json_error "Usage: loop-helper.sh state-update <workspace_dir> <loop_id> [--stdin] [flags...]"
  fi
  _su_ws="$(normalize_dir "$1")"
  _su_lid="$2"
  shift 2
  if ! validate_loop_id "$_su_lid"; then
    emit_json_error "Invalid loop_id: $_su_lid"
  fi
  _su_root="$(resolve_state_root "$_su_ws")"
  _su_loop_dir="$_su_root/loops/$_su_lid"
  _su_file="$_su_loop_dir/state.json"
  if [ ! -f "$_su_file" ]; then
    emit_json_error "Loop state not found: $_su_lid"
  fi

  _su_use_stdin=0
  _su_skip_next=0
  for _arg in "$@"; do
    if [ "$_su_skip_next" -eq 1 ]; then
      _su_skip_next=0
      continue
    fi
    case "$_arg" in
      --stdin)
        _su_use_stdin=1
        ;;
      --status|--iteration|--task-id|--worker-id|--worktree-branch|--last-status|--last-delay-sec|--last-summary|--next-hint|--consecutive-errors|--event|--stop-mode|--stop-requested)
        _su_skip_next=1
        ;;
    esac
  done

  _su_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _su_rc=0
  if [ "$_su_use_stdin" -eq 1 ]; then
    _su_out="$(LP_OP="update" LP_USE_STDIN=1 LP_STATE_FILE="$_su_file" LP_LOOP_ID="$_su_lid" LP_NOW="$_su_now" run_state_engine "$@")" || _su_rc=$?
  else
    _su_out="$(LP_OP="update" LP_USE_STDIN=0 LP_STATE_FILE="$_su_file" LP_LOOP_ID="$_su_lid" LP_NOW="$_su_now" run_state_engine "$@" </dev/null)" || _su_rc=$?
  fi
  if [ "$_su_rc" -ne 0 ]; then
    if [ -n "$_su_out" ]; then
      printf '%s\n' "$_su_out"
    fi
    exit "$_su_rc"
  fi

  _su_state_line="$(printf '%s\n' "$_su_out" | sed -n '1p')"
  _su_event_line="$(printf '%s\n' "$_su_out" | sed -n '2p')"
  write_state_atomic "$_su_loop_dir" "$_su_state_line"
  if [ -n "$_su_event_line" ]; then
    printf '%s\n' "$_su_event_line" >> "$_su_loop_dir/events.jsonl"
  fi
  printf '%s\n' "$_su_state_line"
}

run_state_list_mode() {
  _sl_op="$1"
  _sl_ws="$2"
  _sl_mode="$3"
  _sl_root="$(resolve_state_root "$_sl_ws")"
  collect_loop_state_files "$_sl_root" | LP_OP="$_sl_op" LP_STATE_DIR="$_sl_root" LP_MODE="$_sl_mode" run_state_engine
}

run_state_list() {
  _sl_ws=""
  _sl_ws_set=0
  _sl_mode="active"
  for _arg in "$@"; do
    case "$_arg" in
      --active)
        _sl_mode="active"
        ;;
      --all)
        _sl_mode="all"
        ;;
      -*)
        emit_json_error "Unknown option for state-list: $_arg"
        ;;
      *)
        if [ "$_sl_ws_set" -eq 1 ]; then
          emit_json_error "Unexpected extra argument for state-list: $_arg"
        fi
        _sl_ws="$_arg"
        _sl_ws_set=1
        ;;
    esac
  done
  _sl_ws="$(normalize_dir "${_sl_ws:-$PWD}")"
  run_state_list_mode "list" "$_sl_ws" "$_sl_mode"
}

run_state_stop() {
  if [ "$#" -lt 2 ]; then
    emit_json_error "Usage: loop-helper.sh state-stop <workspace_dir> <loop_id|all> [--after-current]"
  fi
  _ss_ws="$(normalize_dir "$1")"
  shift
  _ss_root="$(resolve_state_root "$_ss_ws")"
  _ss_after=0
  _ss_has_all=0
  _ss_targets=""
  _ss_tcount=0

  for _arg in "$@"; do
    case "$_arg" in
      --after-current)
        _ss_after=1
        ;;
      all|--all|-a)
        _ss_has_all=1
        ;;
      -*)
        emit_json_error "Unknown option for state-stop: $_arg"
        ;;
      *)
        if ! validate_loop_id "$_arg"; then
          emit_json_error "Invalid loop_id: $_arg"
        fi
        _ss_targets="${_ss_targets}${_ss_targets:+
}${_arg}"
        _ss_tcount=$((_ss_tcount + 1))
        ;;
    esac
  done

  if [ "$_ss_has_all" -eq 1 ] && [ "$_ss_tcount" -gt 0 ]; then
    emit_json_error "Cannot combine 'all' with specific loop_id targets"
  fi
  if [ "$_ss_has_all" -eq 0 ] && [ "$_ss_tcount" -eq 0 ]; then
    emit_json_error "Missing loop_id or 'all' target for state-stop"
  fi

  case "$-" in
    *f*) _ss_had_noglob=1 ;;
    *) _ss_had_noglob=0 ;;
  esac

  _ss_files=""
  if [ "$_ss_has_all" -eq 1 ]; then
    _ss_files="$(collect_loop_state_files "$_ss_root")"
  else
    _ss_old_ifs="$IFS"
    IFS='
'
    set -f
    for _ss_lid in $_ss_targets; do
      _ss_sf="$_ss_root/loops/$_ss_lid/state.json"
      if [ ! -f "$_ss_sf" ]; then
        IFS="$_ss_old_ifs"
        if [ "$_ss_had_noglob" -eq 0 ]; then set +f; fi
        emit_json_error "Loop state not found: $_ss_lid"
      fi
      _ss_files="${_ss_files}${_ss_files:+
}${_ss_sf}"
    done
    IFS="$_ss_old_ifs"
    if [ "$_ss_had_noglob" -eq 0 ]; then set +f; fi
  fi

  _ss_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _ss_stopped_lines=""
  if [ -n "$_ss_files" ]; then
    _ss_old_ifs="$IFS"
    IFS='
'
    set -f
    for _ss_sf in $_ss_files; do
      [ -f "$_ss_sf" ] || continue
      _ss_dir="${_ss_sf%/state.json}"
      _ss_lid="${_ss_dir##*/}"
      _ss_rc=0
      _ss_out="$(LP_OP="stop_one" LP_STATE_FILE="$_ss_sf" LP_LOOP_ID="$_ss_lid" LP_AFTER_CURRENT="$_ss_after" LP_NOW="$_ss_now" run_state_engine </dev/null)" || _ss_rc=$?
      if [ "$_ss_rc" -ne 0 ]; then
        IFS="$_ss_old_ifs"
        if [ "$_ss_had_noglob" -eq 0 ]; then set +f; fi
        if [ -n "$_ss_out" ]; then
          printf '%s\n' "$_ss_out"
        fi
        exit "$_ss_rc"
      fi
      if [ -n "$_ss_out" ]; then
        _ss_state_line="$(printf '%s\n' "$_ss_out" | sed -n '1p')"
        _ss_event_line="$(printf '%s\n' "$_ss_out" | sed -n '2p')"
        write_state_atomic "$_ss_dir" "$_ss_state_line"
        if [ -n "$_ss_event_line" ]; then
          printf '%s\n' "$_ss_event_line" >> "$_ss_dir/events.jsonl"
        fi
        _ss_stopped_lines="${_ss_stopped_lines}${_ss_stopped_lines:+
}${_ss_state_line}"
      fi
    done
    IFS="$_ss_old_ifs"
    if [ "$_ss_had_noglob" -eq 0 ]; then set +f; fi
  fi

  printf '%s\n' "$_ss_stopped_lines" | LP_OP="wrap_stopped" LP_STATE_DIR="$_ss_root" run_state_engine
}

run_doctor() {
  clean_mode="$1"
  shift

  ws_arg=""
  ws_set=0
  for arg in "$@"; do
    case "$arg" in
      --clean-shadow)
        clean_mode=1
        ;;
      -*)
        emit_json_error "Unknown option for doctor: $arg"
        ;;
      *)
        if [ "$ws_set" -eq 1 ]; then
          emit_json_error "Unexpected extra argument for doctor: $arg"
        fi
        ws_arg="$arg"
        ws_set=1
        ;;
    esac
  done

  ws_dir="$(normalize_dir "${ws_arg:-$PWD}")"
  home_dir="${HOME:-}"

  c1=""
  c2=""
  c3=""
  c4=""
  backup_dir=""

  if [ "$clean_mode" -eq 1 ] && [ -n "$home_dir" ]; then
    p1="$home_dir/.gemini/config/skills/loop"
    p2="$home_dir/.gemini/config/agents/loop-worker.md"
    p3="$home_dir/.gemini/antigravity-cli/skills/loop"
    p4="$home_dir/.gemini/skills/loop"

    has_any_shadow=0
    if [ -e "$p1" ] || [ -L "$p1" ]; then has_any_shadow=1; fi
    if [ -e "$p2" ] || [ -L "$p2" ]; then has_any_shadow=1; fi
    if [ -e "$p3" ] || [ -L "$p3" ]; then has_any_shadow=1; fi
    if [ -e "$p4" ] || [ -L "$p4" ]; then has_any_shadow=1; fi

    if [ "$has_any_shadow" -eq 1 ]; then
      ts="$(date -u +%Y%m%d-%H%M%SZ)"
      base_backup="$home_dir/.gemini/config/.agy-loop-backup-$ts"
      backup_dir="$base_backup"
      if [ -e "$backup_dir" ] || [ -L "$backup_dir" ]; then
        backup_dir="${base_backup}-$$"
        _seq=1
        while [ -e "$backup_dir" ] || [ -L "$backup_dir" ]; do
          backup_dir="${base_backup}-$$-${_seq}"
          _seq=$((_seq + 1))
        done
      fi
      mkdir -p "$backup_dir"

      if [ -e "$p1" ] || [ -L "$p1" ]; then
        move_shadow_path "$p1" "$backup_dir/config/skills/loop"
        c1="$p1"
      fi
      if [ -e "$p2" ] || [ -L "$p2" ]; then
        move_shadow_path "$p2" "$backup_dir/config/agents/loop-worker.md"
        c2="$p2"
      fi
      if [ -e "$p3" ] || [ -L "$p3" ]; then
        move_shadow_path "$p3" "$backup_dir/antigravity-cli/skills/loop"
        c3="$p3"
      fi
      if [ -e "$p4" ] || [ -L "$p4" ]; then
        move_shadow_path "$p4" "$backup_dir/skills/loop"
        c4="$p4"
      fi
    fi
  fi

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

  active_loops_json="$(run_state_list_mode "doctor_summary" "$ws_dir" "active")"

  LP_S1="$s1" LP_S2="$s2" LP_S3="$s3" LP_S4="$s4" \
  LP_C1="$c1" LP_C2="$c2" LP_C3="$c3" LP_C4="$c4" LP_BACKUP_DIR="$backup_dir" \
  LP_WS_WARNS="$ws_warns" LP_GL_WARNS="$gl_warns" LP_ACTIVE="$active_md" \
  LP_ACTIVE_LOOPS="$active_loops_json" \
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

      cc = 0
      if (ENVIRON["LP_C1"] != "") cleaned[++cc] = ENVIRON["LP_C1"]
      if (ENVIRON["LP_C2"] != "") cleaned[++cc] = ENVIRON["LP_C2"]
      if (ENVIRON["LP_C3"] != "") cleaned[++cc] = ENVIRON["LP_C3"]
      if (ENVIRON["LP_C4"] != "") cleaned[++cc] = ENVIRON["LP_C4"]

      wc = 0
      add_lines(ENVIRON["LP_WS_WARNS"])
      add_lines(ENVIRON["LP_GL_WARNS"])

      ok = (sc == 0 && wc == 0) ? "true" : "false"
      act = ENVIRON["LP_ACTIVE"]
      bdir = ENVIRON["LP_BACKUP_DIR"]
      aloops = ENVIRON["LP_ACTIVE_LOOPS"]
      if (aloops == "") aloops = "[]"

      printf "{\"ok\":%s,\"shadows\":[", ok
      for (i = 1; i <= sc; i++) {
        if (i > 1) printf ","
        printf "\"%s\"", json_escape(shadows[i])
      }
      printf "],\"cleaned_shadows\":["
      for (i = 1; i <= cc; i++) {
        if (i > 1) printf ","
        printf "\"%s\"", json_escape(cleaned[i])
      }
      printf "],\"backup_dir\":"
      if (bdir != "") {
        printf "\"%s\"", json_escape(bdir)
      } else {
        printf "null"
      }
      printf ",\"skill_filter_warnings\":["
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
      printf ",\"active_loops\":%s}\n", aloops
      exit 0
    }
  '
}

extract_session_ws() {
  LP_PWD="$PWD" POSIXLY_CORRECT=1 LC_ALL=C awk '
    function norm_ws(p) {
      if (p == "") p = ENVIRON["LP_PWD"]
      while (length(p) > 1 && substr(p, length(p), 1) == "/") {
        p = substr(p, 1, length(p) - 1)
      }
      return p
    }
    BEGIN { raw = "" }
    { raw = (NR == 1) ? $0 : (raw "\n" $0) }
    END {
      n = length(raw)
      i = 1
      ntk = 0
      while (i <= n) {
        ch = substr(raw, i, 1)
        if (ch == " " || ch == "\t" || ch == "\r" || ch == "\n") {
          i++; continue
        }
        if (ch == "\"") {
          sval = ""
          i++
          while (i <= n) {
            sc = substr(raw, i, 1)
            if (sc == "\\" && i < n) {
              nx = substr(raw, i + 1, 1)
              if (nx == "n") sval = sval "\n"
              else if (nx == "r") sval = sval "\r"
              else if (nx == "t") sval = sval "\t"
              else sval = sval nx
              i += 2; continue
            }
            if (sc == "\"") { i++; break }
            sval = sval sc
            i++
          }
          ntk++; tk_type[ntk] = "STR"; tk_val[ntk] = sval
          continue
        }
        if (ch == ":" || ch == "[" || ch == "]" || ch == "{" || ch == "}" || ch == ",") {
          ntk++; tk_type[ntk] = "SYM"; tk_val[ntk] = ch; i++; continue
        }
        j = i
        while (j <= n) {
          c2 = substr(raw, j, 1)
          if (c2 == " " || c2 == "\t" || c2 == "\r" || c2 == "\n" || c2 == "\"" || c2 == ":" || c2 == "[" || c2 == "]" || c2 == "{" || c2 == "}" || c2 == ",") break
          j++
        }
        ntk++; tk_type[ntk] = "LIT"; tk_val[ntk] = substr(raw, i, j - i); i = j
      }

      ws_cwd = ""
      ws_root = ""
      ws_first = ""
      bdepth = 0
      for (k = 1; k <= ntk; k++) {
        if (tk_type[k] == "SYM") {
          if (tk_val[k] == "{") bdepth++
          else if (tk_val[k] == "}") bdepth--
        } else if (bdepth == 1 && k <= ntk - 2 && tk_type[k] == "STR" && tk_type[k + 1] == "SYM" && tk_val[k + 1] == ":") {
          if (k == 1 || (tk_type[k - 1] == "SYM" && (tk_val[k - 1] == "{" || tk_val[k - 1] == ","))) {
            if (tk_val[k] == "cwd" && tk_type[k + 2] == "STR" && ws_cwd == "") {
              ws_cwd = tk_val[k + 2]
            } else if (tk_val[k] == "workspaceRoot" && tk_type[k + 2] == "STR" && ws_root == "") {
              ws_root = tk_val[k + 2]
            } else if (tk_val[k] == "workspacePaths" && tk_type[k + 2] == "SYM" && tk_val[k + 2] == "[" && k + 3 <= ntk && tk_type[k + 3] == "STR" && ws_first == "") {
              ws_first = tk_val[k + 3]
            }
          }
        }
      }

      ws = ws_cwd
      if (ws == "") ws = ws_root
      if (ws == "") ws = ws_first
      printf "%s\n", norm_ws(ws)
      exit 0
    }
  '
}

run_session_start() {
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

  if [ ! -t 0 ]; then
    ws="$(extract_session_ws)"
  else
    ws="$(normalize_dir "$PWD")"
  fi

  ws_warns=""
  if [ -f "$ws/.agents/skills.json" ]; then
    ws_warns="$(inspect_skills_json "$ws/.agents/skills.json")"
  fi
  gl_warns=""
  if [ -n "$home_dir" ] && [ -f "$home_dir/.gemini/config/skills.json" ]; then
    gl_warns="$(inspect_skills_json "$home_dir/.gemini/config/skills.json")"
  fi

  # Clean fast-exit: emit "{}" (0 tokens, zero UI noise, strictly protojson-compliant)
  if [ -z "$s1$s2$s3$s4" ] && [ -z "$ws_warns" ] && [ -z "$gl_warns" ]; then
    printf '{}\n'
    exit 0
  fi

  LP_S1="$s1" LP_S2="$s2" LP_S3="$s3" LP_S4="$s4" LP_WS="$ws" \
  LP_WS_WARNS="$ws_warns" LP_GL_WARNS="$gl_warns" \
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

    function add_warns(blob,    n, idx, arr) {
      if (blob == "") return
      n = split(blob, arr, "\n")
      for (idx = 1; idx <= n; idx++) {
        if (arr[idx] != "") {
          fwarns[++fc] = arr[idx]
        }
      }
    }

    BEGIN {
      init_tables()
      ws = ENVIRON["LP_WS"]

      sc = 0
      if (ENVIRON["LP_S1"] != "") shadows[++sc] = ENVIRON["LP_S1"]
      if (ENVIRON["LP_S2"] != "") shadows[++sc] = ENVIRON["LP_S2"]
      if (ENVIRON["LP_S3"] != "") shadows[++sc] = ENVIRON["LP_S3"]
      if (ENVIRON["LP_S4"] != "") shadows[++sc] = ENVIRON["LP_S4"]

      fc = 0
      add_warns(ENVIRON["LP_WS_WARNS"])
      add_warns(ENVIRON["LP_GL_WARNS"])

      sys_msg = ""
      user_md = ""

      if (sc > 0) {
        inline_list = ""
        md_bullets = ""
        for (m = 1; m <= sc; m++) {
          if (m > 1) inline_list = inline_list ", "
          inline_list = inline_list shadows[m]
          md_bullets = md_bullets "> - `" shadows[m] "`\n"
        }

        sys_msg = "[agy-loop] Shadow warning (workspace: " ws "): Pre-existing user-level customization path(s) (" inline_list ") take higher discovery precedence than plugins and shadow loop-worker and/or /loop (forcing stale loop-worker tools even when invoking /agy-loop:loop). Explain this collision and offer to archive them non-destructively via `sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow` (followed by `/skills reload`) or `/agy-loop:loop doctor --clean-shadow`."

        user_md = "> [!WARNING]\n" \
          "> **AGY Loop (`agy-loop`): Local Shadow Customization(s) Detected**\n" \
          "> Pre-existing user-level file(s) take precedence over plugins and shadow `loop-worker` and/or `/loop` (even under `/agy-loop:loop`):\n" \
          md_bullets \
          ">\n" \
          "> Archive them non-destructively into `~/.gemini/config/.agy-loop-backup-<timestamp>/` with one command:\n" \
          "> ```sh\n" \
          "> sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow\n" \
          "> ```\n" \
          "> Then run `/skills reload` (or run `/agy-loop:loop doctor --clean-shadow` right here in chat)."
      }

      if (fc > 0) {
        finline = ""
        fbullets = ""
        for (m = 1; m <= fc; m++) {
          if (m > 1) finline = finline "; "
          finline = finline fwarns[m]
          fbullets = fbullets "> - " fwarns[m] "\n"
        }

        fsys = "[agy-loop] skills.json filter warning (workspace: " ws "): " finline ". Skill filter rules (include_only/exclude) may block `loop` or `agy-loop:loop` from loading. Inspect the reported skills.json or run `/agy-loop:loop doctor`."
        if (sys_msg != "") sys_msg = sys_msg " " fsys
        else sys_msg = fsys

        fmd = "> [!WARNING]\n" \
          "> **AGY Loop (`agy-loop`): `skills.json` Filter Restriction Detected**\n" \
          "> The following skill filter configuration may block `/agy-loop:loop`:\n" \
          fbullets \
          ">\n" \
          "> Update the `include_only` / `exclude` rule(s) in `skills.json` (or inspect with `npx agy-loop doctor`), then run `/skills reload`."
        if (user_md != "") user_md = user_md "\n\n" fmd
        else user_md = fmd
      }

      printf "{\"injectSteps\":[{\"systemMessage\":{\"systemMessage\":\"%s\",\"metadata\":{\"user_markdown\":\"%s\"}}}]}\n",
        json_escape(sys_msg),
        json_escape(user_md)
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
    run_doctor 0 "$@"
    ;;
  clean-shadow)
    run_doctor 1 "$@"
    ;;
  session-start)
    run_session_start "$@"
    ;;
  state-init)
    run_state_init "$@"
    ;;
  state-read)
    run_state_read "$@"
    ;;
  state-update)
    run_state_update "$@"
    ;;
  state-list)
    run_state_list "$@"
    ;;
  state-stop)
    run_state_stop "$@"
    ;;
  help|--help|-h|"")
    printf '%s\n' '{"usage":"loop-helper.sh <parse|resolve-task|doctor|clean-shadow|session-start|state-init|state-read|state-update|state-list|state-stop> [args...]"}'
    exit 0
    ;;
  *)
    emit_json_error "Unknown subcommand: $SUBCMD"
    ;;
esac
