/*!
 * \file planetary_parameters.h
 * \brief Centralized planetary parameters (gravity, rotation, etc.)
 * \author GNSS-SDR Mars Adaptation Team
 */

#ifndef GNSS_SDR_PLANETARY_PARAMETERS_H
#define GNSS_SDR_PLANETARY_PARAMETERS_H

/** \addtogroup Core
 * \{ */
/** \addtogroup System_Parameters
 * \{ */

// Select active planet
#ifndef GNSS_PLANETARY_CONTEXT
#define GNSS_PLANETARY_CONTEXT_EARTH
#endif

namespace PlanetaryParams {

struct PlanetProperties {
    double mu;            //!< Gravitational constant [m^3/s^2]
    double omega_dot;     //!< Rotation rate [rad/s]
    double semi_major_a;  //!< Semi-major axis (a) [m]
    double flattening_f;  //!< Flattening (f)
    double j2;            //!< Second zonal harmonic
};

#if defined(GNSS_PLANETARY_CONTEXT_MARS)
// Martian parameters
constexpr double MU = 4.282837e13;
constexpr double OMEGA_DOT = 7.088218e-5;
constexpr double SEMI_MAJOR_A = 3396190.0;
constexpr double FLATTENING_F = 1.0 / 169.8;
constexpr double J2 = 1.96045e-3;
#else
// Earth (WGS84) parameters
constexpr double MU = 3.986004418e14;
constexpr double OMEGA_DOT = 7.2921151467e-5;
constexpr double SEMI_MAJOR_A = 6378137.0;
constexpr double FLATTENING_F = 1.0 / 298.257223563;
constexpr double J2 = 1.082627e-3;
#endif

}  // namespace PlanetaryParams

/** \} */
/** \} */

#endif  // GNSS_SDR_PLANETARY_PARAMETERS_H
