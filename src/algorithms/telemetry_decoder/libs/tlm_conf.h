/*!
 * \file tlm_conf.h
 * \brief Class that contains all the configuration parameters for generic
 * telemetry decoder block.
 * \author Carles Fernandez, 2020. cfernandez(at)cttc.es
 *
 * -----------------------------------------------------------------------------
 *
 * GNSS-SDR is a Global Navigation Satellite System software-defined receiver.
 * This file is part of GNSS-SDR.
 *
 * Copyright (C) 2010-2020  (see AUTHORS file for a list of contributors)
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * -----------------------------------------------------------------------------
 */

#ifndef GNSS_SDR_TLM_CONF_H
#define GNSS_SDR_TLM_CONF_H

#include "configuration_interface.h"
#include <string>

/** \addtogroup Telemetry_Decoder
 * \{ */
/** \addtogroup Telemetry_Decoder_libs
 * \{ */


class Tlm_Conf
{
public:
    Tlm_Conf() = default;

    void SetFromConfiguration(const ConfigurationInterface *configuration, const std::string &role);

    std::string dump_filename;
    std::string dump_crc_stats_filename;
    bool dump{false};
    bool dump_mat{false};
    bool remove_dat{false};
    bool enable_reed_solomon{false};  // for INAV message in Galileo E1B
    bool dump_crc_stats{false};       // telemetry CRC statistics
    bool enable_navdata_monitor{false};
    bool enable_costas_branch_repair{false};
    bool enable_assisted_tow{false};
    std::string assisted_nav_bits_file;
    uint32_t assisted_tow_start_ms{0U};
    int32_t assisted_nav_min_match_bits{295};
    int32_t assisted_tow_min_preamble_score{8};
    double assisted_tow_light_time_ms{100.0};
    double assisted_tow_boundary_tolerance_ms{120.0};
    double assisted_tow_min_cn0_dbhz{0.0};
    double ephemeris_mars_frame_phase_offset_s{0.0};
    double ephemeris_mars_frame_phase_offset_rad{0.0};
    double ephemeris_time_offset_s{0.0};
    bool there_are_e1_channels{false};
    bool there_are_e6_channels{false};
    bool use_ced{false};
};


/** \} */
/** \} */
#endif  // GNSS_SDR_TLM_CONF_H
