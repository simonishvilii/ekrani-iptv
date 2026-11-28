/*
 * Writes racing/app/media/keep.mp4: a tiny black H.264 clip (128x128, 2 s, no sound).
 * The Racing game plays it, muted and hidden behind the 3D canvas, while people play: on webOS a
 * playing video keeps the TV's screen saver away (players use phones, so the remote sends no keys).
 *   node tools/make-keepawake-video.js
 * Hand-built so the repo needs no encoder: one IDR frame of uncompressed (I_PCM) macroblocks,
 * then P frames that skip every macroblock. Baseline profile, CAVLC.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const W = 128, H = 128, FRAMES = 8, DELTA = 250, TIMESCALE = 1000;   // 8 frames x 250 ms = 2 s
const MBS = (W / 16) * (H / 16);

/* ---------- H.264 bitstream ---------- */
function Bits() { this.out = []; this.cur = 0; this.n = 0; }
Bits.prototype.bit = function (x) {
  this.cur = (this.cur << 1) | (x & 1); this.n++;
  if (this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
};
Bits.prototype.u = function (v, len) { for (let i = len - 1; i >= 0; i--) this.bit((v >> i) & 1); };
Bits.prototype.ue = function (v) {
  v += 1; let len = 0;
  while ((v >> (len + 1)) > 0) len++;
  this.u(0, len); this.u(v, len + 1);
};
Bits.prototype.se = function (v) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); };
Bits.prototype.align = function () { while (this.n) this.bit(0); };
Bits.prototype.trailing = function () { this.bit(1); this.align(); };
Bits.prototype.bytes = function (arr) { if (this.n) throw new Error('not aligned'); for (const b of arr) this.out.push(b); };

/* NAL unit: header byte + payload with emulation prevention bytes */
function nal(refIdc, type, payload) {
  const out = [(refIdc << 5) | type];
  let zeros = 0;
  for (const b of payload) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

function sps() {
  const b = new Bits();
  b.u(66, 8);            // Baseline
  b.u(0xC0, 8);          // constraint_set0 + set1
  b.u(30, 8);            // level 3.0
  b.ue(0);               // seq_parameter_set_id
  b.ue(0);               // log2_max_frame_num_minus4 (frame_num: 4 bits)
  b.ue(2);               // pic_order_cnt_type 2 (output order = decode order)
  b.ue(1);               // max_num_ref_frames
  b.bit(0);              // gaps_in_frame_num_value_allowed_flag
  b.ue(W / 16 - 1); b.ue(H / 16 - 1);
  b.bit(1);              // frame_mbs_only_flag
  b.bit(1);              // direct_8x8_inference_flag
  b.bit(0);              // frame_cropping_flag
  b.bit(0);              // vui_parameters_present_flag
  b.trailing();
  return nal(3, 7, b.out);
}

function pps() {
  const b = new Bits();
  b.ue(0); b.ue(0);      // pps id, sps id
  b.bit(0);              // CAVLC
  b.bit(0);              // bottom_field_pic_order_in_frame_present_flag
  b.ue(0);               // num_slice_groups_minus1
  b.ue(0); b.ue(0);      // num_ref_idx_l0/l1_default_active_minus1
  b.bit(0); b.u(0, 2);   // weighted_pred_flag, weighted_bipred_idc
  b.se(0); b.se(0); b.se(0);   // pic_init_qp/qs_minus26, chroma_qp_index_offset
  b.bit(0); b.bit(0); b.bit(0); // deblocking_filter_control_present, constrained_intra_pred, redundant_pic_cnt_present
  b.trailing();
  return nal(3, 8, b.out);
}

function idr() {
  const b = new Bits();
  b.ue(0);               // first_mb_in_slice
  b.ue(7);               // slice_type: I (all slices)
  b.ue(0);               // pps id
  b.u(0, 4);             // frame_num
  b.ue(0);               // idr_pic_id
  b.bit(0); b.bit(0);    // dec_ref_pic_marking: no_output_of_prior_pics, long_term_reference
  b.se(0);               // slice_qp_delta
  const luma = new Array(256).fill(16), chroma = new Array(128).fill(128);   // black
  for (let i = 0; i < MBS; i++) {
    b.ue(25);            // mb_type I_PCM
    b.align();           // pcm_alignment_zero_bits
    b.bytes(luma); b.bytes(chroma);
  }
  b.trailing();
  return nal(3, 5, b.out);
}

function pSkip(frameNum) {
  const b = new Bits();
  b.ue(0);               // first_mb_in_slice
  b.ue(5);               // slice_type: P (all slices)
  b.ue(0);               // pps id
  b.u(frameNum & 15, 4); // frame_num
  b.bit(0);              // num_ref_idx_active_override_flag
  b.bit(0);              // ref_pic_list_modification_flag_l0
  b.bit(0);              // adaptive_ref_pic_marking_mode_flag
  b.se(0);               // slice_qp_delta
  b.ue(MBS);             // mb_skip_run: the whole picture
  b.trailing();
  return nal(2, 1, b.out);
}

/* ---------- MP4 ---------- */
function u8(v) { return Buffer.from([v & 255]); }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; }
function str(s) { return Buffer.from(s, 'latin1'); }
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), str(type), body]);
}
function full(type, version, flags, ...parts) { return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts); }
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

const S = sps(), P = pps();
const samples = [idr()];
for (let f = 1; f < FRAMES; f++) samples.push(pSkip(f));
const sampleBufs = samples.map(n => Buffer.concat([u32(n.length), n]));
const DURATION = FRAMES * DELTA;

function moov(chunkOffset) {
  const avcC = box('avcC', u8(1), u8(66), u8(0xC0), u8(30), u8(0xff), u8(0xe1), u16(S.length), S, u8(1), u16(P.length), P);
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12), u16(W), u16(H),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), avcC);
  const stbl = box('stbl',
    full('stsd', 0, 0, u32(1), avc1),
    full('stts', 0, 0, u32(1), u32(FRAMES), u32(DELTA)),
    full('stss', 0, 0, u32(1), u32(1)),
    full('stsc', 0, 0, u32(1), u32(1), u32(FRAMES), u32(1)),
    full('stsz', 0, 0, u32(0), u32(FRAMES), ...sampleBufs.map(b => u32(b.length))),
    full('stco', 0, 0, u32(1), u32(chunkOffset)));
  const minf = box('minf',
    full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
    box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
    stbl);
  const mdia = box('mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(DURATION), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler\0')),
    minf);
  const trak = box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(DURATION), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(W << 16), u32(H << 16)),
    mdia);
  return box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(DURATION), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX,
      Buffer.alloc(24), u32(2)),
    trak);
}

const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
const offset = ftyp.length + moov(0).length + 8;
const file = Buffer.concat([ftyp, moov(offset), box('mdat', ...sampleBufs)]);
const out = path.join(__dirname, '..', 'racing', 'app', 'media', 'keep.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, file);
console.log('wrote ' + path.relative(path.join(__dirname, '..'), out) + ' (' + file.length + ' bytes)');
