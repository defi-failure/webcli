#pragma once
#include <string>
#include <vector>
#include <mutex>
#include <fstream>
#include <algorithm>
#include <chrono>
#include "json.hpp"

namespace octra {

constexpr const char* DAPP_CONNECTIONS_FILE = "data/connections.json";
constexpr int DAPP_CONN_TTL_DAYS = 90;
constexpr size_t DAPP_CONN_CAP_PER_WALLET = 64;

struct DappConnection {
    std::string origin;
    std::string wallet_addr;
    long long created_ts = 0;
    long long last_seen_ts = 0;
};

class DappConnections {
    std::vector<DappConnection> entries_;
    mutable std::mutex mtx_;

    static long long now_s() {
        return std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    void prune_locked() {
        long long cutoff = now_s() - (long long)DAPP_CONN_TTL_DAYS * 86400LL;
        entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
            [cutoff](const DappConnection& e) { return e.last_seen_ts < cutoff; }),
            entries_.end());

        std::vector<std::pair<std::string, size_t>> counts;
        for (auto& e : entries_) {
            auto it = std::find_if(counts.begin(), counts.end(),
                [&](const auto& p) { return p.first == e.wallet_addr; });
            if (it == counts.end()) counts.push_back({e.wallet_addr, 1});
            else it->second++;
        }
        for (auto& c : counts) {
            if (c.second <= DAPP_CONN_CAP_PER_WALLET) continue;
            std::vector<size_t> idxs;
            for (size_t i = 0; i < entries_.size(); i++) {
                if (entries_[i].wallet_addr == c.first) idxs.push_back(i);
            }
            std::sort(idxs.begin(), idxs.end(), [this](size_t a, size_t b) {
                return entries_[a].last_seen_ts < entries_[b].last_seen_ts;
            });
            size_t to_drop = c.second - DAPP_CONN_CAP_PER_WALLET;
            std::vector<bool> drop(entries_.size(), false);
            for (size_t i = 0; i < to_drop && i < idxs.size(); i++) drop[idxs[i]] = true;
            std::vector<DappConnection> kept;
            for (size_t i = 0; i < entries_.size(); i++) {
                if (!drop[i]) kept.push_back(entries_[i]);
            }
            entries_ = std::move(kept);
        }
    }

    void save_locked() const {
        nlohmann::json arr = nlohmann::json::array();
        for (auto& e : entries_) {
            arr.push_back({
                {"origin", e.origin},
                {"wallet_addr", e.wallet_addr},
                {"created_ts", e.created_ts},
                {"last_seen_ts", e.last_seen_ts},
            });
        }
        nlohmann::json root;
        root["version"] = 1;
        root["entries"] = arr;
        std::ofstream f(DAPP_CONNECTIONS_FILE);
        if (f) f << root.dump(2);
    }

public:
    void load() {
        std::lock_guard<std::mutex> lk(mtx_);
        entries_.clear();
        std::ifstream f(DAPP_CONNECTIONS_FILE);
        if (!f) return;
        try {
            nlohmann::json root;
            f >> root;
            if (!root.is_object() || !root.contains("entries")) return;
            for (auto& j : root["entries"]) {
                DappConnection e;
                e.origin = j.value("origin", "");
                e.wallet_addr = j.value("wallet_addr", "");
                e.created_ts = j.value("created_ts", 0LL);
                e.last_seen_ts = j.value("last_seen_ts", 0LL);
                if (!e.origin.empty() && !e.wallet_addr.empty()) {
                    entries_.push_back(e);
                }
            }
        } catch (...) {}
        prune_locked();
    }

    bool is_connected(const std::string& origin, const std::string& wallet_addr) const {
        std::lock_guard<std::mutex> lk(mtx_);
        for (auto& e : entries_) {
            if (e.origin == origin && e.wallet_addr == wallet_addr) return true;
        }
        return false;
    }

    void upsert(const std::string& origin, const std::string& wallet_addr) {
        std::lock_guard<std::mutex> lk(mtx_);
        long long t = now_s();
        for (auto& e : entries_) {
            if (e.origin == origin && e.wallet_addr == wallet_addr) {
                e.last_seen_ts = t;
                save_locked();
                return;
            }
        }
        DappConnection e;
        e.origin = origin;
        e.wallet_addr = wallet_addr;
        e.created_ts = t;
        e.last_seen_ts = t;
        entries_.push_back(e);
        prune_locked();
        save_locked();
    }

    void touch(const std::string& origin, const std::string& wallet_addr) {
        std::lock_guard<std::mutex> lk(mtx_);
        long long t = now_s();
        for (auto& e : entries_) {
            if (e.origin == origin && e.wallet_addr == wallet_addr) {
                e.last_seen_ts = t;
                save_locked();
                return;
            }
        }
    }

    bool remove(const std::string& origin, const std::string& wallet_addr) {
        std::lock_guard<std::mutex> lk(mtx_);
        auto before = entries_.size();
        entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
            [&](const DappConnection& e) {
                return e.origin == origin && e.wallet_addr == wallet_addr;
            }), entries_.end());
        if (entries_.size() != before) { save_locked(); return true; }
        return false;
    }

    void remove_by_wallet(const std::string& wallet_addr) {
        std::lock_guard<std::mutex> lk(mtx_);
        auto before = entries_.size();
        entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
            [&](const DappConnection& e) { return e.wallet_addr == wallet_addr; }),
            entries_.end());
        if (entries_.size() != before) save_locked();
    }

    std::vector<DappConnection> list_for_wallet(const std::string& wallet_addr) const {
        std::lock_guard<std::mutex> lk(mtx_);
        std::vector<DappConnection> out;
        for (auto& e : entries_) {
            if (e.wallet_addr == wallet_addr) out.push_back(e);
        }
        return out;
    }
};

inline bool is_valid_http_origin(const std::string& origin) {
    if (origin.empty() || origin == "null") return false;
    if (origin.size() > 512) return false;

    for (unsigned char c : origin) {
        if (c <= 0x20 || c == 0x7f) return false;
    }

    size_t scheme_end;
    if (origin.compare(0, 7, "http://") == 0) scheme_end = 7;
    else if (origin.compare(0, 8, "https://") == 0) scheme_end = 8;
    else return false;

    if (scheme_end >= origin.size()) return false;

    for (size_t i = scheme_end; i < origin.size(); i++) {
        char c = origin[i];
        if (c == '/' || c == '?' || c == '#' || c == '@') return false;
    }

    char first = origin[scheme_end];
    if (first == ':') return false;

    return true;
}

}  // namespace octra
