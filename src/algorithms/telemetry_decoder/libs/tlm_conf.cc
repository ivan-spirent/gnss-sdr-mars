/*!
 * \file tlm_conf.cc
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

#include "tlm_conf.h"
#include <utility>


void Tlm_Conf::SetFromConfiguration(const ConfigurationInterface *configuration,
    const std::string &role)
{
    const std::string default_dumpname("telemetry");
    dump_filename = configuration->property(role + ".dump_filename", default_dumpname);
    dump = configuration->property(role + ".dump", false);
    dump_mat = configuration->property(role + ".dump_mat", dump);
    remove_dat = configuration->property(role + ".remove_dat", false);
    dump_crc_stats = configuration->property(role + ".dump_crc_stats", false);
    enable_costas_branch_repair = configuration->property(role + ".enable_costas_branch_repair", false);
    enable_assisted_tow = configuration->property(role + ".enable_assisted_tow", false);
    assisted_nav_bits_file = configuration->property(role + ".assisted_nav_bits_file", assisted_nav_bits_file);
    assisted_tow_start_ms = configuration->property(role + ".assisted_tow_start_ms", assisted_tow_start_ms);
    assisted_nav_min_match_bits = configuration->property(role + ".assisted_nav_min_match_bits", assisted_nav_min_match_bits);
    assisted_tow_min_preamble_score = configuration->property(role + ".assisted_tow_min_preamble_score", assisted_tow_min_preamble_score);
    assisted_tow_light_time_ms = configuration->property(role + ".assisted_tow_light_time_ms", assisted_tow_light_time_ms);
    assisted_tow_boundary_tolerance_ms = configuration->property(role + ".assisted_tow_boundary_tolerance_ms", assisted_tow_boundary_tolerance_ms);
    assisted_tow_min_cn0_dbhz = configuration->property(role + ".assisted_tow_min_cn0_dbhz", assisted_tow_min_cn0_dbhz);
    apply_ephemeris_frame_alignment = configuration->property(role + ".apply_ephemeris_frame_alignment", apply_ephemeris_frame_alignment);
    ephemeris_mars_frame_phase_offset_s = configuration->property(role + ".ephemeris_mars_frame_phase_offset_s", ephemeris_mars_frame_phase_offset_s);
    ephemeris_mars_frame_phase_offset_rad = configuration->property(role + ".ephemeris_mars_frame_phase_offset_rad", ephemeris_mars_frame_phase_offset_rad);
    ephemeris_time_offset_s = configuration->property(role + ".ephemeris_time_offset_s", ephemeris_time_offset_s);
    const std::string default_crc_stats_dumpname("telemetry_crc_stats");
    dump_crc_stats_filename = configuration->property(role + ".dump_crc_stats_filename", default_crc_stats_dumpname);
    enable_navdata_monitor = configuration->property("NavDataMonitor.enable_monitor", false);
    if (configuration->property("Channels_1B.count", 0) > 0)
        {
            there_are_e1_channels = true;
        }

    if (configuration->property("Channels_E6.count", 0) > 0)
        {
            there_are_e6_channels = true;
        }
}
